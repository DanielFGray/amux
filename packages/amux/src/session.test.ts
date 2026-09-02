import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Path, Schema as S } from "effect";
import {
  isSessionId,
  parseSessionState,
  SessionStore,
  sessionPaths,
  sessionRoot,
} from "./session.ts";
import { MAX_SPACES } from "./limits.ts";
import type { JsonValue } from "./effect/AttachProtocol.ts";
import { testEffect } from "./test-effect.ts";

const dirs: string[] = [];
const join = (...paths: string[]) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.join(...paths)).pipe(Effect.provide(Path.layer)),
  );
const basename = (value: string) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.basename(value)).pipe(Effect.provide(Path.layer)),
  );
const fsRun = <A>(effect: Effect.Effect<A, PlatformError, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)));
const mkdtemp = (prefix: string) =>
  fsRun(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.makeTempDirectory({ directory: tmpdir(), prefix: basename(prefix) }),
    ),
  );
const rm = (path: string, _options?: { recursive?: boolean; force?: boolean }) =>
  fsRun(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(path, { recursive: true, force: true }),
    ),
  );
const mkdir = (path: string, options?: { recursive?: boolean; mode?: number }) =>
  fsRun(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(path, options)));
const chmod = (path: string, mode: number) =>
  fsRun(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.chmod(path, mode)));
const stat = (path: string) => fsRun(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(path)));
const readFile = (path: string, _encoding?: string) =>
  fsRun(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)));
afterEach(() =>
  Effect.runPromise(
    Effect.forEach(
      dirs.splice(0),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      {
        discard: true,
      },
    ),
  ),
);

function env() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-session-")));
      dirs.push(home);
      return { HOME: home, XDG_STATE_HOME: join(home, "state") };
    }),
  );
}

const encodeJson = (value: JsonValue) => S.encodeEffect(S.fromJsonString(S.Unknown))(value);
const expectRejected = (promise: Promise<unknown>) =>
  promise.then(
    () => Promise.reject(new Error("expected promise to reject")),
    () => undefined,
  );

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
      Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  );

testEffect("session writes are atomic and recover the previous generation", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) => store.save(state("one"))),
        e,
      ),
    );
    const next = { ...state("one"), attached: true };
    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) => store.save(next)),
        e,
      ),
    );
    expect(
      (yield* Effect.promise(() =>
        run(
          Effect.flatMap(SessionStore, (store) => store.load("one")),
          e,
        ),
      ))?.attached,
    ).toBe(true);
    const paths = yield* Effect.promise(() => run(sessionPaths("one"), e));
    const contents = yield* Effect.promise(() => readFile(paths.backup, "utf8"));
    const backup = yield* S.decodeEffect(S.fromJsonString(S.Struct({ attached: S.Boolean })))(
      contents,
    );
    expect(backup.attached).toBe(false);
  }),
);

testEffect("a truncated current file falls back to the previous generation", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) => store.save(state("recover"))),
        e,
      ),
    );
    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) =>
          store.save({ ...state("recover"), attached: true }),
        ),
        e,
      ),
    );
    const paths = yield* Effect.promise(() => run(sessionPaths("recover"), e));
    yield* Effect.promise(() => Bun.write(paths.state, '{"version":1'));
    expect(
      (yield* Effect.promise(() =>
        run(
          Effect.flatMap(SessionStore, (store) => store.load("recover")),
          e,
        ),
      ))?.attached,
    ).toBe(false);
  }),
);

testEffect("a dead lease leaves the session it owned intact", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) => store.save(state("dead"))),
        e,
      ),
    );
    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) =>
          store.writeLease({
            version: 1,
            session: "dead",
            pid: 999999,
            socket: "/tmp/dead.sock",
            startedAt: 1,
            heartbeatAt: 1,
          }),
        ),
        e,
      ),
    );
    // A lease says who is running the session, never whether it should exist.
    // Its owner dying is how a session waits to be restored, not how one ends.
    expect(
      yield* Effect.promise(() =>
        run(
          Effect.flatMap(SessionStore, (store) => store.load("dead")),
          e,
        ),
      ),
    ).not.toBeNull();
  }),
);

testEffect("lease files are schema-validated before ownership checks", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const paths = yield* Effect.promise(() => run(sessionPaths("lease-validation"), e));
    yield* Effect.promise(() => mkdir(paths.root, { recursive: true }));

    const invalidOwnerLease = yield* encodeJson({
      version: 1,
      session: "other-session",
      pid: process.pid,
      socket: paths.socket,
      startedAt: 1,
      heartbeatAt: 1,
    });
    yield* Effect.promise(() => Bun.write(paths.lease, invalidOwnerLease));
    expect(
      yield* Effect.promise(() =>
        run(
          Effect.flatMap(SessionStore, (store) => store.readLease("lease-validation")),
          e,
        ),
      ),
    ).toBeNull();

    const invalidSocketLease = yield* encodeJson({
      version: 1,
      session: "lease-validation",
      pid: process.pid,
      socket: "",
      startedAt: 1,
      heartbeatAt: 1,
    });
    yield* Effect.promise(() => Bun.write(paths.lease, invalidSocketLease));
    expect(
      yield* Effect.promise(() =>
        run(
          Effect.flatMap(SessionStore, (store) => store.readLease("lease-validation")),
          e,
        ),
      ),
    ).toBeNull();

    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) =>
          store.writeLease({
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
        ),
        e,
      ),
    );
    expect(
      yield* Effect.promise(() =>
        run(
          Effect.flatMap(SessionStore, (store) => store.readLease("lease-validation")),
          e,
        ),
      ),
    ).toMatchObject({
      session: "lease-validation",
      attachedSince: 3,
      attachments: [{ client: "client-a" }],
    });
  }),
);

testEffect("valid session ids resolve to a single path component", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const root = yield* Effect.promise(() => run(sessionRoot, e));
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
      const paths = yield* Effect.promise(() => run(sessionPaths(id), e));
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
  }),
);

testEffect("invalid session ids are rejected before any path is built", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
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
      yield* Effect.promise(() => expectRejected(run(sessionPaths(id), e)));
    }
  }),
);

testEffect("no session helper touches the filesystem for a traversal id", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) => store.save(state("ok"))),
        e,
      ),
    );
    for (const id of ["..", "../escape", "a/../../victim"]) {
      yield* Effect.promise(() =>
        expectRejected(
          run(
            Effect.flatMap(SessionStore, (store) => store.load(id)),
            e,
          ),
        ),
      );
      yield* Effect.promise(() =>
        expectRejected(
          run(
            Effect.flatMap(SessionStore, (store) => store.remove(id)),
            e,
          ),
        ),
      );
      expect(
        yield* Effect.promise(() =>
          run(
            Effect.flatMap(SessionStore, (store) => store.exists(id)),
            e,
          ),
        ),
      ).toBe(false);
    }
    // The valid session is untouched.
    expect(
      yield* Effect.promise(() =>
        run(
          Effect.flatMap(SessionStore, (store) => store.load("ok")),
          e,
        ),
      ),
    ).not.toBeNull();
  }),
);

testEffect("traversal ids cannot read or delete files outside the sessions root", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const victim = join(e.HOME!, "victim.json");
    yield* Effect.promise(() => Bun.write(victim, "secret"));
    yield* Effect.promise(() =>
      expectRejected(
        run(
          Effect.flatMap(SessionStore, (store) => store.save({ ...state("../..") })),
          e,
        ),
      ),
    );
    yield* Effect.promise(() =>
      expectRejected(
        run(
          Effect.flatMap(SessionStore, (store) => store.remove("..")),
          e,
        ),
      ),
    );
    yield* Effect.promise(() =>
      expectRejected(
        run(
          Effect.flatMap(SessionStore, (store) => store.remove("../..")),
          e,
        ),
      ),
    );
    expect(yield* Effect.promise(() => Bun.file(victim).exists())).toBe(true);
    expect(yield* Effect.promise(() => Bun.file(victim).text())).toBe("secret");
  }),
);

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
            sessions: [
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
  malformed.spaces[0].windows[0].sessions[0].rows = -1;
  expect(() => Effect.runSync(parseSessionState(malformed))).toThrow("invalid persisted session");
  const huge = structuredClone(value);
  huge.spaces[0].windows[0].sessions[0].cols = 1_000_000;
  huge.spaces[0].windows[0].sessions[0].rows = 1_000_000;
  expect(() => Effect.runSync(parseSessionState(huge))).toThrow("invalid persisted session");
});

test("persisted state uses session vocabulary and migrates legacy agent keys", () => {
  const current: any = {
    ...state("session-vocabulary"),
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
            sessions: [
              {
                id: "session-a",
                name: "a",
                declaredAgent: "native",
                cmd: ["sh"],
                cols: 80,
                rows: 24,
                exited: false,
                exitCode: null,
              },
            ],
          },
        ],
      },
    ],
  };
  const legacy = structuredClone(current);
  legacy.spaces[0].windows[0].agents = legacy.spaces[0].windows[0].sessions;
  delete legacy.spaces[0].windows[0].sessions;
  legacy.spaces[0].windows[0].agents[0].agent = legacy.spaces[0].windows[0].agents[0].declaredAgent;
  delete legacy.spaces[0].windows[0].agents[0].declaredAgent;

  expect(Effect.runSync(parseSessionState(current))).toEqual(current);
  expect(Effect.runSync(parseSessionState(legacy))).toEqual(current);
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
            sessions: [],
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

testEffect("the directory holding a session's sockets is owner-only", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const paths = yield* Effect.promise(() => run(sessionPaths("modes"), e));
    // The mode a directory is created with is not the mode it keeps: an earlier
    // tool, or a restore that dropped permissions, can leave the root wide open,
    // and creating it again would not narrow it. The daemon's control and attach
    // sockets live in here, so the mode is a property worth asserting.
    yield* Effect.promise(() => mkdir(paths.root, { recursive: true, mode: 0o755 }));
    yield* Effect.promise(() => chmod(paths.root, 0o755));
    expect((yield* Effect.promise(() => stat(paths.root))).mode & 0o777).toBe(0o755);

    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) => store.save(state("modes"))),
        e,
      ),
    );
    expect((yield* Effect.promise(() => stat(paths.root))).mode & 0o777).toBe(0o700);
  }),
);
