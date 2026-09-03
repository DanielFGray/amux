/**
 * Reads the last N messages straight out of a harness's own durable session
 * log, on demand, for a given working directory. amux never copies this data
 * anywhere: each call re-reads whatever the harness has on disk right now.
 *
 * One static adapter per harness, keyed by the id `identifyAgent`
 * (`@danielfgray/amux-agent-facts/identify.ts`) or a session's
 * `declaredAgent` produces. Modeled on scrape-my-messages' knowledge of each
 * harness's on-disk format, generalized from "messages the user typed" to
 * "the last N messages of any role" and scoped to one project directory
 * instead of a global incremental scan.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { DateTime, Effect, Option, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface HarnessLogMessage {
  readonly role: string;
  readonly text: string;
  readonly timestamp: string;
}

type FsEffect<A> = Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>;

interface HarnessLogAdapter {
  readLast(cwd: string, limit: number, home: string): FsEffect<HarnessLogMessage[]>;
}

const isoOf = (epochMillis: number): string =>
  Option.match(DateTime.make(epochMillis), {
    onNone: () => String(epochMillis),
    onSome: DateTime.formatIso,
  });

const findFiles = (dir: string, suffix: string): FsEffect<string[]> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(dir, { recursive: true });
    return entries.filter((name) => name.endsWith(suffix)).map((name) => path.join(dir, name));
  }).pipe(Effect.orElseSucceed((): string[] => []));

const mtimeOf = (file: string): FsEffect<number> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(file);
    return Option.match(info.mtime, { onNone: () => -1, onSome: (d) => d.getTime() });
  }).pipe(Effect.orElseSucceed(() => -1));

function parseJsonLines(content: string): unknown[] {
  const parsed: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // skip corrupt line
    }
  }
  return parsed;
}

const readJsonLines = (file: string): FsEffect<unknown[]> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(file);
    return parseJsonLines(content);
  }).pipe(Effect.orElseSucceed((): unknown[] => []));

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The one content shape shared by every harness: plain text, or a list of
// blocks (tool calls, tool results, text) where only the text ones matter.
const ContentBlockSchema = S.Struct({ text: S.optionalKey(S.String) });
const ContentSchema = S.Union([S.String, S.Array(ContentBlockSchema)]);
type Content = typeof ContentSchema.Type;
const decodeContentBlock = S.decodeUnknownOption(ContentBlockSchema);

function textOfContent(content: Content): string {
  if (typeof content === "string") return content.trim();
  return content
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

const ClaudeLineSchema = S.Struct({
  type: S.Literals(["user", "assistant"]),
  isSidechain: S.optionalKey(S.Boolean),
  timestamp: S.String,
  message: S.Struct({ role: S.String, content: ContentSchema }),
});
const decodeClaudeLine = S.decodeUnknownOption(ClaudeLineSchema);

const CodexMetaSchema = S.Struct({
  type: S.Literal("session_meta"),
  payload: S.Struct({ cwd: S.String }),
});
const decodeCodexMeta = S.decodeUnknownOption(CodexMetaSchema);

const CodexMessageSchema = S.Struct({
  type: S.Literal("response_item"),
  timestamp: S.String,
  payload: S.Struct({ type: S.Literal("message"), role: S.String, content: ContentSchema }),
});
const decodeCodexMessage = S.decodeUnknownOption(CodexMessageSchema);

const OpencodeMessageSchema = S.Struct({ role: S.String });
const decodeOpencodeMessage = S.decodeUnknownOption(OpencodeMessageSchema);

// ---- claude-code: ~/.claude/projects/<cwd with / and . -> ->/*.jsonl ----
const CLAUDE_CODE: HarnessLogAdapter = {
  // One project directory holds every Claude Code session ever run against
  // this cwd, concurrent ones included; only the most recently written file
  // is this reader's own, so — like the other adapters below — pick that one
  // file rather than merging every session's messages into one stream.
  readLast: (cwd, limit, home) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = path.join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
      const files = yield* findFiles(dir, ".jsonl");
      let best: string | undefined;
      for (const file of files) {
        if (!best || (yield* mtimeOf(file)) > (yield* mtimeOf(best))) best = file;
      }
      if (!best) return [];
      const messages: HarnessLogMessage[] = [];
      for (const raw of yield* readJsonLines(best)) {
        const decoded = decodeClaudeLine(raw);
        if (Option.isNone(decoded)) continue;
        const line = decoded.value;
        if (line.isSidechain === true) continue;
        const text = textOfContent(line.message.content);
        if (!text) continue;
        messages.push({ role: line.message.role, text, timestamp: line.timestamp });
      }
      messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return messages.slice(-limit);
    }),
};

// ---- opencode: sqlite dbs under ~/.local/share/opencode/*.db ----
const OPENCODE: HarnessLogAdapter = {
  readLast: (cwd, limit, home) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = path.join(home, ".local", "share", "opencode");
      const dbFiles = yield* findFiles(dir, ".db");
      return readOpencodeLast(dbFiles, cwd, limit);
    }),
};

function readOpencodeLast(dbFiles: string[], cwd: string, limit: number): HarnessLogMessage[] {
  let best: { dbPath: string; sessionId: string; timeCreated: number } | undefined;
  for (const dbPath of dbFiles) {
    let db: Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      continue;
    }
    try {
      const row = db
        .query(
          "SELECT id, time_created FROM session WHERE directory = ? ORDER BY time_created DESC LIMIT 1",
        )
        .get(cwd) as { id: string; time_created: number } | null;
      if (row && (!best || row.time_created > best.timeCreated))
        best = { dbPath, sessionId: row.id, timeCreated: row.time_created };
    } finally {
      db.close();
    }
  }
  if (!best) return [];
  const db = new Database(best.dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT ?",
      )
      .all(best.sessionId, limit) as { id: string; time_created: number; data: string }[];
    const partStmt = db.query("SELECT data FROM part WHERE message_id = ? ORDER BY id");
    const messages: HarnessLogMessage[] = [];
    for (const row of rows.reverse()) {
      const decoded = decodeOpencodeMessage(tryParseJson(row.data));
      if (Option.isNone(decoded)) continue;
      const parts = partStmt.all(row.id) as { data: string }[];
      const text = parts
        .map((p) =>
          Option.getOrElse(
            Option.map(decodeContentBlock(tryParseJson(p.data)), (block) => block.text ?? ""),
            () => "",
          ),
        )
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (!text) continue;
      messages.push({ role: decoded.value.role, text, timestamp: isoOf(row.time_created) });
    }
    return messages;
  } finally {
    db.close();
  }
}

// ---- codex: ~/.codex/sessions/**/*.jsonl ----
const CODEX: HarnessLogAdapter = {
  readLast: (cwd, limit, home) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = path.join(home, ".codex", "sessions");
      const files = yield* findFiles(dir, ".jsonl");
      let best: string | undefined;
      for (const file of files) {
        const lines = yield* readJsonLines(file);
        const meta = lines.map((l) => decodeCodexMeta(l)).find(Option.isSome);
        if (!meta || meta.value.payload.cwd !== cwd) continue;
        if (!best || (yield* mtimeOf(file)) > (yield* mtimeOf(best))) best = file;
      }
      if (!best) return [];
      const messages: HarnessLogMessage[] = [];
      for (const raw of yield* readJsonLines(best)) {
        const decoded = decodeCodexMessage(raw);
        if (Option.isNone(decoded)) continue;
        const line = decoded.value;
        const text = textOfContent(line.payload.content);
        if (!text) continue;
        messages.push({ role: line.payload.role, text, timestamp: line.timestamp });
      }
      return messages.slice(-limit);
    }),
};

// ---- copilot: ~/.copilot/session-store.db ----
// The schema only carries `turns.user_message`, so assistant replies are not
// recoverable from this store: every message this adapter returns is "user".
const COPILOT: HarnessLogAdapter = {
  readLast: (cwd, limit, home) =>
    Effect.sync(() => {
      const dbPath = `${home}/.copilot/session-store.db`;
      let db: Database;
      try {
        db = new Database(dbPath, { readonly: true });
      } catch {
        return [];
      }
      try {
        const rows = db
          .query(
            `SELECT turns.user_message as text, turns.timestamp as timestamp
             FROM turns JOIN sessions ON turns.session_id = sessions.id
             WHERE sessions.cwd = ? AND user_message IS NOT NULL AND trim(user_message) != ''
             ORDER BY turns.timestamp DESC LIMIT ?`,
          )
          .all(cwd, limit) as { text: string; timestamp: string }[];
        return rows
          .reverse()
          .map((row) => ({ role: "user", text: row.text.trim(), timestamp: row.timestamp }));
      } finally {
        db.close();
      }
    }),
};

const ADAPTERS = {
  claude: CLAUDE_CODE,
  opencode: OPENCODE,
  codex: CODEX,
  copilot: COPILOT,
} satisfies Record<string, HarnessLogAdapter>;

/** Best-effort: an unsupported harness or a read failure both mean "nothing
 *  to show" rather than an error — the caller has no durable log either way.
 *  `home` defaults to the real home directory; a test passes a fixture root. */
export function readHarnessLog(
  harness: string | undefined,
  cwd: string | undefined,
  limit: number,
  home: string = homedir(),
): FsEffect<readonly HarnessLogMessage[]> {
  if (!harness || !cwd || !Object.hasOwn(ADAPTERS, harness)) return Effect.succeed([]);
  const adapter = ADAPTERS[harness as keyof typeof ADAPTERS];
  return adapter.readLast(cwd, limit, home).pipe(Effect.orElseSucceed(() => []));
}
