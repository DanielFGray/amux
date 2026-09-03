import { afterEach, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { DateTime, Effect, Layer, Option, Path } from "effect";
import { testEffect } from "@danielfgray/amux/testing";
import { readHarnessLog } from "./harness-log.ts";

const join = (...paths: string[]) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.join(...paths)).pipe(Effect.provide(Path.layer)),
  );

const mkdtemp = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeTempDirectory({ directory: tmpdir(), prefix }),
  );
const mkdir = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(path, { recursive: true }));
const writeFile = (path: string, content: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, content));
const rm = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(path, { recursive: true, force: true }));

const dirs: string[] = [];
const mkHome = Effect.gen(function* () {
  const dir = yield* mkdtemp("amux-harness-log-");
  dirs.push(dir);
  return dir;
});
afterEach(() =>
  Effect.runPromise(
    Effect.forEach(dirs.splice(0), (dir) => rm(dir), { discard: true }).pipe(
      Effect.provide(BunFileSystem.layer),
    ),
  ),
);

const claudeProjectDir = (home: string, cwd: string) =>
  join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));

function stringifyLine<T>(line: T | string): string {
  return typeof line === "string" ? line : JSON.stringify(line);
}
function writeJsonl<T>(path: string, lines: readonly (T | string)[]) {
  return writeFile(path, lines.map(stringifyLine).join("\n"));
}

const writeClaudeFixture = <T>(home: string, cwd: string, lines: readonly (T | string)[]) =>
  Effect.gen(function* () {
    const dir = claudeProjectDir(home, cwd);
    yield* mkdir(dir);
    yield* writeJsonl(join(dir, "session.jsonl"), lines);
  });

const writeCodexFixture = <T>(home: string, files: ReadonlyMap<string, readonly (T | string)[]>) =>
  Effect.gen(function* () {
    const dir = join(home, ".codex", "sessions");
    yield* mkdir(dir);
    for (const [name, lines] of files) yield* writeJsonl(join(dir, name), lines);
  });

interface OpencodeFixtureSession {
  readonly id: string;
  readonly directory: string;
  readonly timeCreated: number;
  readonly messages: readonly {
    readonly timeCreated: number;
    readonly role: string;
    readonly parts: readonly string[];
  }[];
}

/** Plain sqlite work, outside any Effect.gen: bun:sqlite has no Effect wrapper. */
function insertOpencodeFixture(dbPath: string, sessions: readonly OpencodeFixtureSession[]): void {
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER)");
  db.exec(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
  );
  db.exec("CREATE TABLE part (id INTEGER PRIMARY KEY, message_id TEXT, data TEXT)");
  let messageSeq = 0;
  for (const session of sessions) {
    db.query("INSERT INTO session (id, directory, time_created) VALUES (?, ?, ?)").run(
      session.id,
      session.directory,
      session.timeCreated,
    );
    for (const message of session.messages) {
      const messageId = `m${++messageSeq}`;
      db.query("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
        messageId,
        session.id,
        message.timeCreated,
        JSON.stringify({ role: message.role }),
      );
      for (const text of message.parts)
        db.query("INSERT INTO part (message_id, data) VALUES (?, ?)").run(
          messageId,
          JSON.stringify({ type: "text", text }),
        );
    }
  }
  db.close();
}

const writeOpencodeFixture = Effect.fnUntraced(function* (
  home: string,
  sessions: readonly OpencodeFixtureSession[],
) {
  const dir = join(home, ".local", "share", "opencode");
  yield* mkdir(dir);
  insertOpencodeFixture(join(dir, "store.db"), sessions);
});

function insertCopilotFixture(
  dbPath: string,
  sessions: readonly { readonly id: string; readonly cwd: string }[],
  turns: readonly {
    readonly sessionId: string;
    readonly userMessage: string;
    readonly timestamp: string;
  }[],
): void {
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)");
  db.exec(
    "CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT, user_message TEXT, timestamp TEXT)",
  );
  for (const session of sessions)
    db.query("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run(session.id, session.cwd);
  for (const turn of turns)
    db.query("INSERT INTO turns (session_id, user_message, timestamp) VALUES (?, ?, ?)").run(
      turn.sessionId,
      turn.userMessage,
      turn.timestamp,
    );
  db.close();
}

const writeCopilotFixture = Effect.fnUntraced(function* (
  home: string,
  sessions: readonly { readonly id: string; readonly cwd: string }[],
  turns: readonly {
    readonly sessionId: string;
    readonly userMessage: string;
    readonly timestamp: string;
  }[],
) {
  const dir = join(home, ".copilot");
  yield* mkdir(dir);
  insertCopilotFixture(join(dir, "session-store.db"), sessions, turns);
});

const isoOf = (epochMillis: number) =>
  Option.match(DateTime.make(epochMillis), {
    onNone: () => String(epochMillis),
    onSome: DateTime.formatIso,
  });

const { live } = testEffect(BunFileSystem.layer.pipe(Layer.provideMerge(BunPath.layer)));

live("returns nothing for an unknown harness", () =>
  Effect.gen(function* () {
    const home = yield* mkHome;
    const result = yield* readHarnessLog("nonexistent-harness", "/some/project", 10, home);
    expect(result).toEqual([]);
  }),
);

live("returns nothing when harness or cwd is missing", () =>
  Effect.gen(function* () {
    const home = yield* mkHome;
    expect(yield* readHarnessLog(undefined, "/some/project", 10, home)).toEqual([]);
    expect(yield* readHarnessLog("claude", undefined, 10, home)).toEqual([]);
  }),
);

live("claude-code: reads the last N messages of any role for a matching cwd", () =>
  Effect.gen(function* () {
    const home = yield* mkHome;
    const cwd = "/home/dan/build/amux";
    // Sidechains, non-message lines, and corrupt lines are all excluded.
    yield* writeClaudeFixture(home, cwd, [
      {
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      },
      {
        type: "user",
        isSidechain: true,
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "should be skipped" },
      },
      { type: "summary", summary: "not a message" },
      "{broken",
    ]);

    const result = yield* readHarnessLog("claude", cwd, 10, home);
    expect(result).toEqual([
      { role: "user", text: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", text: "hi there", timestamp: "2026-01-01T00:00:01.000Z" },
    ]);
  }),
);

live("claude-code: caps to the last N messages", () =>
  Effect.gen(function* () {
    const home = yield* mkHome;
    const cwd = "/proj";
    yield* writeClaudeFixture(
      home,
      cwd,
      Array.from({ length: 5 }, (_, i) => ({
        type: "user",
        timestamp: `2026-01-01T00:00:0${i}.000Z`,
        message: { role: "user", content: `message ${i}` },
      })),
    );

    const result = yield* readHarnessLog("claude", cwd, 2, home);
    expect(result.map((m) => m.text)).toEqual(["message 3", "message 4"]);
  }),
);

live("codex: matches the session whose session_meta.cwd equals the target cwd", () =>
  Effect.gen(function* () {
    const home = yield* mkHome;
    const cwd = "/proj/codex";
    yield* writeCodexFixture(
      home,
      new Map([
        [
          "s1.jsonl",
          [
            { type: "session_meta", payload: { id: "s1", cwd } },
            {
              type: "response_item",
              timestamp: "2026-01-01T00:00:00.000Z",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "text", text: "do the thing" }],
              },
            },
            {
              type: "response_item",
              timestamp: "2026-01-01T00:00:01.000Z",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "done" }],
              },
            },
          ],
        ],
        [
          "s2.jsonl",
          [
            { type: "session_meta", payload: { id: "s2", cwd: "/some/other/proj" } },
            {
              type: "response_item",
              timestamp: "2026-01-01T00:00:00.000Z",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "text", text: "wrong project" }],
              },
            },
          ],
        ],
      ]),
    );

    const result = yield* readHarnessLog("codex", cwd, 10, home);
    expect(result).toEqual([
      { role: "user", text: "do the thing", timestamp: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", text: "done", timestamp: "2026-01-01T00:00:01.000Z" },
    ]);
  }),
);

live("opencode: reads messages+parts for the most recent matching session", () =>
  Effect.gen(function* () {
    const home = yield* mkHome;
    const cwd = "/proj/opencode";
    yield* writeOpencodeFixture(home, [
      {
        id: "sess-1",
        directory: cwd,
        timeCreated: 1000,
        messages: [{ timeCreated: 1001, role: "user", parts: ["opencode message"] }],
      },
      { id: "sess-2", directory: "/other/proj", timeCreated: 2000, messages: [] },
    ]);

    const result = yield* readHarnessLog("opencode", cwd, 10, home);
    expect(result).toEqual([{ role: "user", text: "opencode message", timestamp: isoOf(1001) }]);
  }),
);

live("copilot: only user turns are recoverable from the store schema", () =>
  Effect.gen(function* () {
    const home = yield* mkHome;
    const cwd = "/proj/copilot";
    yield* writeCopilotFixture(
      home,
      [{ id: "sess-1", cwd }],
      [
        {
          sessionId: "sess-1",
          userMessage: "copilot prompt",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    );

    const result = yield* readHarnessLog("copilot", cwd, 10, home);
    expect(result).toEqual([
      { role: "user", text: "copilot prompt", timestamp: "2026-01-01T00:00:00.000Z" },
    ]);
  }),
);
