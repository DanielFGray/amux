import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect } from "effect";
import {
  isSessionId,
  parseSessionState,
  SessionStore,
  sessionPaths,
  sessionRoot,
} from "./session.ts";
import { MAX_SPACES } from "./limits.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function env() {
  const home = await mkdtemp(join(tmpdir(), "amux-session-"));
  dirs.push(home);
  return { HOME: home, XDG_STATE_HOME: join(home, "state") };
}

function state(id: string) {
  return {
    version: 1 as const,
    id,
    createdAt: 1,
    updatedAt: 1,
    attached: false,
    spaces: [],
  };
}

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SessionStore.Default),
      Effect.provide(BunFileSystem.layer),
      Effect.withConfigProvider(ConfigProvider.fromJson(env)),
    ),
  );

test("session writes are atomic and recover the previous generation", async () => {
  const e = await env();
  await run(SessionStore.save(state("one")), e);
  const next = { ...state("one"), attached: true };
  await run(SessionStore.save(next), e);
  expect((await run(SessionStore.load("one"), e))?.attached).toBe(true);
  expect(
    JSON.parse(await readFile((await run(sessionPaths("one"), e)).backup, "utf8")).attached,
  ).toBe(false);
});

test("a truncated current file falls back to the previous generation", async () => {
  const e = await env();
  await run(SessionStore.save(state("recover")), e);
  await run(SessionStore.save({ ...state("recover"), attached: true }), e);
  await Bun.write((await run(sessionPaths("recover"), e)).state, '{"version":1');
  expect((await run(SessionStore.load("recover"), e))?.attached).toBe(false);
});

test("a dead lease leaves the session it owned intact", async () => {
  const e = await env();
  await run(SessionStore.save(state("dead")), e);
  await run(
    SessionStore.writeLease({
      version: 1,
      session: "dead",
      pid: 999999,
      socket: "/tmp/dead.sock",
      startedAt: 1,
      heartbeatAt: 1,
    }),
    e,
  );
  // A lease says who is running the session, never whether it should exist.
  // Its owner dying is how a session waits to be restored, not how one ends.
  expect(await run(SessionStore.load("dead"), e)).not.toBeNull();
});

test("lease files are schema-validated before ownership checks", async () => {
  const e = await env();
  const paths = await run(sessionPaths("lease-validation"), e);
  await mkdir(paths.root, { recursive: true });

  await Bun.write(
    paths.lease,
    JSON.stringify({
      version: 1,
      session: "other-session",
      pid: process.pid,
      socket: paths.socket,
      startedAt: 1,
      heartbeatAt: 1,
    }),
  );
  expect(await run(SessionStore.readLease("lease-validation"), e)).toBeNull();

  await Bun.write(
    paths.lease,
    JSON.stringify({
      version: 1,
      session: "lease-validation",
      pid: process.pid,
      socket: "",
      startedAt: 1,
      heartbeatAt: 1,
    }),
  );
  expect(await run(SessionStore.readLease("lease-validation"), e)).toBeNull();

  await run(
    SessionStore.writeLease({
      version: 1,
      session: "lease-validation",
      pid: process.pid,
      socket: paths.socket,
      startedAt: 1,
      heartbeatAt: 2,
      attachedSince: 3,
      attachLastSeen: 4,
      attachments: [{ client: "client-a", attachedSince: 3, attachLastSeen: 4 }],
    }),
    e,
  );
  expect(await run(SessionStore.readLease("lease-validation"), e)).toMatchObject({
    session: "lease-validation",
    attachedSince: 3,
    attachments: [{ client: "client-a" }],
  });
});

test("valid session ids resolve to a single path component", async () => {
  const e = await env();
  const root = await run(sessionRoot(), e);
  const ids = [
    "default",
    "e2e-boot-1",
    "c3f2a9b4-1d7e-4c5b-9f6a-0e8d2b7a4f11",
    ".hidden",
    "...",
    "..hidden",
    "_leading",
    "-leading",
    "a.b_c-1",
    "a",
    "x".repeat(128),
  ];
  for (const id of ids) {
    expect(isSessionId(id)).toBe(true);
    const paths = await run(sessionPaths(id), e);
    expect(paths.root).toBe(join(root, id));
    for (const file of [
      paths.state,
      paths.backup,
      paths.lease,
      paths.lock,
      paths.socket,
      paths.attach,
    ]) {
      expect(file.startsWith(root + "/")).toBe(true);
    }
  }
});

test("invalid session ids are rejected before any path is built", async () => {
  const e = await env();
  const ids = [
    "",
    ".",
    "..",
    "../escape",
    "a/b",
    "a/b/c",
    "a/../b",
    "a\\b",
    "a\nb",
    "a\tb",
    "a\u0000b",
    "\u001b[0m",
    "a b",
    "a".repeat(129),
    "h\u00e9llo",
    "\u{1F600}",
  ];
  for (const id of ids) {
    expect(isSessionId(id)).toBe(false);
    await expect(run(sessionPaths(id), e)).rejects.toThrow(
      `invalid session id ${JSON.stringify(id)}`,
    );
  }
});

test("no session helper touches the filesystem for a traversal id", async () => {
  const e = await env();
  await run(SessionStore.save(state("ok")), e);
  for (const id of ["..", "../escape", "a/../../victim"]) {
    await expect(run(SessionStore.load(id), e)).rejects.toThrow();
    await expect(run(SessionStore.remove(id), e)).rejects.toThrow();
    await expect(run(SessionStore.exists(id), e)).resolves.toBe(false);
  }
  // The valid session is untouched.
  expect(await run(SessionStore.load("ok"), e)).not.toBeNull();
});

test("traversal ids cannot read or delete files outside the sessions root", async () => {
  const e = await env();
  const victim = join(e.HOME!, "victim.json");
  await Bun.write(victim, "secret");
  await expect(run(SessionStore.save({ ...state("../..") }), e)).rejects.toThrow();
  await expect(run(SessionStore.remove(".."), e)).rejects.toThrow();
  await expect(run(SessionStore.remove("../.."), e)).rejects.toThrow();
  expect(await Bun.file(victim).exists()).toBe(true);
  expect(await Bun.file(victim).text()).toBe("secret");
});

test("nested persisted state rejects duplicate identities and invalid layout relationships", () => {
  const value: any = {
    ...state("nested"),
    activeSpace: "space-a",
    spaces: [
      {
        id: "space-a",
        name: "a",
        dir: "/tmp",
        activeWindow: 1,
        windows: [
          {
            number: 1,
            name: null,
            agents: [
              {
                id: "agent-a",
                name: "a",
                cmd: ["sh"],
                cols: 80,
                rows: 24,
                exited: false,
                exitCode: null,
              },
            ],
            layout: JSON.stringify({
              version: 1,
              root: {
                type: "pane",
                id: "pane-a",
                content: { kind: "pty", session: "agent-a" },
                weight: 1,
              },
              focus: "pane-a",
            }),
          },
        ],
      },
    ],
  };
  expect(Effect.runSync(parseSessionState(value))).toEqual(value);
  const duplicate = structuredClone(value);
  duplicate.spaces.push(structuredClone(value.spaces[0]));
  expect(() => Effect.runSync(parseSessionState(duplicate))).toThrow("invalid persisted space");
  const missing = structuredClone(value);
  missing.spaces[0].windows[0].layout = JSON.stringify({
    version: 1,
    root: { type: "pane", id: "pane-a", content: { kind: "pty", session: "missing" }, weight: 1 },
  });
  expect(() => Effect.runSync(parseSessionState(missing))).toThrow("absent or exited session");
  const malformed = structuredClone(value);
  malformed.spaces[0].windows[0].agents[0].rows = -1;
  expect(() => Effect.runSync(parseSessionState(malformed))).toThrow("invalid persisted agent");
  const huge = structuredClone(value);
  huge.spaces[0].windows[0].agents[0].cols = 1_000_000;
  huge.spaces[0].windows[0].agents[0].rows = 1_000_000;
  expect(() => Effect.runSync(parseSessionState(huge))).toThrow("invalid persisted agent");
});

test("persisted layouts validate focus through the layout decoder", () => {
  const value: any = {
    ...state("layout-decode"),
    spaces: [
      {
        id: "space-a",
        name: "a",
        dir: "/tmp",
        activeWindow: 1,
        windows: [
          {
            number: 1,
            name: null,
            agents: [],
            layout: JSON.stringify({ version: 1, root: null, focus: "missing" }),
          },
        ],
      },
    ],
  };
  expect(() => Effect.runSync(parseSessionState(value))).toThrow("layout focus names no pane");
});

test("persisted snapshots bound aggregate model size", () => {
  const crowded: any = state("crowded");
  crowded.spaces = Array.from({ length: MAX_SPACES + 1 }, (_, i) => ({
    id: `space-${i}`,
    name: "s",
    dir: "/tmp",
    activeWindow: null,
    windows: [],
  }));
  crowded.activeSpace = crowded.spaces[0].id;
  expect(() => Effect.runSync(parseSessionState(crowded))).toThrow("too many spaces");
});
