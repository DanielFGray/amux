/** @effect-diagnostics *:skip-file -- a real OS boundary (sockets, subprocess, git) this suite deliberately
 * drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join as nodeJoin } from "node:path";
import { Cause, ConfigProvider, Effect, Exit, Fiber, Layer, Path, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import {
  startDaemon,
  type SessionDaemonOptions,
  type SessionDaemonService,
} from "../packages/amux/src/daemon.ts";
import { SessionStore, sessionPaths } from "../packages/amux/src/session.ts";
import { Command, command } from "../packages/amux/src/commands.ts";
import { controlCall, type ControlClient } from "../packages/amux/src/control-client.ts";
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "../packages/amux/src/effect/AttachProtocol.ts";
import { gitWorktreeExists, worktreeDirname } from "../packages/amux/src/git.ts";
import { waitFor, until } from "../packages/amux/src/test-wait.ts";
import { testEffect } from "../packages/amux/src/test-effect.ts";
import { registerCleanup, tempDir } from "../packages/amux/src/test-tmp.ts";
import type { WorkspaceCommandContext } from "../packages/amux/src/workspace-command-context.ts";

registerCleanup();

// --- shared daemon open/run helpers (from daemon.test.ts) ---

async function env(prefix = "daemon") {
  const home = tempDir(prefix);
  return { HOME: home, XDG_STATE_HOME: nodeJoin(home, "state") };
}

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path | Scope.Scope>,
  e: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(e)),
      ),
    ),
  );

const open = (id: string, e: NodeJS.ProcessEnv, options?: SessionDaemonOptions) =>
  run(startDaemon(id, options), e);

const st = (d: SessionDaemonService) => Effect.runSync(d.getState);
const ws = (d: SessionDaemonService) => Effect.runSync(d.getWorkspace);
const S = (d: SessionDaemonService) => Effect.runPromise(d.stop);

const ctl = <A, E>(
  id: string,
  e: NodeJS.ProcessEnv,
  use: (control: ControlClient) => Effect.Effect<A, E>,
) => run(controlCall(id, use), e);

const expectProcessGone = (pid: number) =>
  waitFor(
    () =>
      readFile(`/proc/${pid}/stat`).then(
        () => false,
        () => true,
      ),
    `process ${pid} to exit`,
    2_000,
  );

// --- attach-host fixture (from attachhost.test.ts) ---

const pathJoin = (...paths: string[]) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.join(...paths)).pipe(Effect.provide(Path.layer)),
  );

const daemons: SessionDaemonService[] = [];
const attachEnvs = new Map<string, NodeJS.ProcessEnv>();

const attachRun = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(
        SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  );

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const daemon of daemons.splice(0)) yield* daemon.stop.pipe(Effect.ignore);
    }),
  ),
);

const started = Effect.fnUntraced(function* (id: string) {
  const home = tempDir("attach-host");
  const env = { HOME: home, XDG_STATE_HOME: pathJoin(home, "state") };
  const daemon = yield* Effect.promise(() => attachRun(Effect.scoped(startDaemon(id)), env));
  daemons.push(daemon);
  attachEnvs.set(daemon.id, env);
  return daemon;
});

/** A client of the attach socket that keeps every frame it was sent. */
function client(path: string, hello: string, extra: string = "") {
  const frames: AttachFrame[] = [];
  let buffer = "";
  return Bun.connect({
    unix: path,
    socket: {
      binaryType: "buffer",
      open(socket) {
        // Written as one payload on purpose: a real client will batch its
        // hello with whatever it already wanted to say, and both must land.
        socket.write(encodeAttachFrame({ _tag: "hello", client: hello }) + extra);
      },
      data(_socket, data) {
        buffer += data.toString("utf8");
        const decoded = decodeAttachFrames(buffer);
        buffer = decoded.rest;
        frames.push(...decoded.frames);
      },
    },
  }).then((socket) => ({ socket, frames }));
}

const text = (frames: AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => Buffer.from(frame.data).toString("utf8"))
    .join("");

// --- git-worktree helpers (from git-worktree.test.ts) ---

const wtRun = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path>,
  e: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(e)),
    ),
  );

const wtOpen = (id: string, e: NodeJS.ProcessEnv) => wtRun(Effect.scoped(startDaemon(id)), e);
const close = (d: SessionDaemonService) => Effect.runPromise(d.close);
const runCommand = (
  d: SessionDaemonService,
  value: Command,
  revision: number,
  context: WorkspaceCommandContext,
) => Effect.runPromise(d.runWorkspaceCommand(value, revision, context));

const git = async (args: string[], cwd: string): Promise<string> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
  return out.trim();
};

/** A scratch repository with one initial commit, so worktrees have a base. */
async function initRepo(): Promise<string> {
  const repo = tempDir("repo");
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "t@t.org"], repo);
  await git(["config", "user.name", "T"], repo);
  await writeFile(nodeJoin(repo, "readme.md"), "groceries\n");
  await git(["add", "readme.md"], repo);
  await git(["commit", "-m", "groceries"], repo);
  return repo;
}

// =============================================================================
// From daemon.test.ts
// =============================================================================

test("concurrent opens reject the second owner and release on stop", async () => {
  const e = await env();
  const first = await open("race", e);
  await expect(open("race", e)).rejects.toThrow(/already (being opened|owned)/);
  await expect(open("race", e)).rejects.toThrow(/already (being opened|owned)/);
  await S(first);
  expect(
    await run(
      Effect.flatMap(SessionStore, (store) => store.load("race")),
      e,
    ),
  ).toBeNull();
});

test("a dead lease and stale lock are recovered without deleting state", async () => {
  const e = await env();
  const p = await run(sessionPaths("restart"), e);
  await Bun.write(
    p.state,
    JSON.stringify({
      version: 1,
      id: "restart",
      createdAt: 1,
      updatedAt: 1,
      attached: true,
      spaces: [],
    }),
  );
  await writeFile(p.lock, "999999\n");
  await run(
    Effect.flatMap(SessionStore, (store) =>
      store.writeLease({
        version: 1,
        session: "restart",
        pid: 999999,
        socket: p.socket,
        startedAt: 1,
        heartbeatAt: 1,
      }),
    ),
    e,
  );
  const d = await open("restart", e);
  expect(st(d).id).toBe("restart");
  expect(st(d).attached).toBe(false);
  await S(d);
});

/**
 * The signal path, through a real process because that is the only place the
 * finalizer runs. A reboot, an OOM kill or a stray `kill` must cost the user
 * nothing but the daemon: persisting the layout buys nothing if the state dies
 * with the process that held it.
 */
test("a daemon killed by a signal leaves its session restorable", async () => {
  const e = await env();
  const entry = new URL("../packages/amux/src/daemon-main.ts", import.meta.url).pathname;
  const child = Bun.spawn({
    cmd: [process.execPath, entry, "signalled"],
    env: { ...process.env, ...e },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Answering on the control socket is what "started" means, and only a
  // started daemon has registered the finalizer under test. Waiting for the
  // lease instead would race it: the lease is written first.
  const p = await run(sessionPaths("signalled"), e);
  await waitFor(
    () =>
      run(
        controlCall("signalled", (c) => c.Ping()),
        e,
      ).then(
        () => true,
        () => false,
      ),
    "the daemon to answer on its control socket",
    10_000,
  );

  child.kill("SIGTERM");
  await child.exited;

  expect(
    await run(
      Effect.flatMap(SessionStore, (store) => store.load("signalled")),
      e,
    ),
  ).not.toBeNull();
  // The daemon is gone even though the session is not: what a signal ends is
  // the process, and the lease is the thing that names a running one.
  expect(await Bun.file(p.lease).exists()).toBe(false);
});

testEffect("a blocked daemon write does not starve timers, RPC, or shutdown", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const daemon = yield* Effect.promise(() => open("responsive", e));
    // started by startDaemon;
    try {
      const pty = yield* daemon.spawnSession({
        id: "blocked",
        cmd: ["sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      });
      const write = yield* Effect.forkChild(pty.write("x".repeat(16 * 1024 * 1024)));
      let timerRan = false;
      setTimeout(() => {
        timerRan = true;
      }, 25);
      const response = yield* Effect.promise(() =>
        Promise.race([
          ctl("responsive", e, (c) => c.Ping()),
          Bun.sleep(1000).then(() => {
            throw new Error("RPC deadline exceeded");
          }),
        ]),
      );
      expect(response.attached).toBe(false);
      yield* Effect.promise(() =>
        waitFor(() => timerRan, "the timer to run despite the blocked write"),
      );
      expect(timerRan).toBe(true);
      yield* daemon.killSession("blocked");
      const writeResult = yield* Effect.race(
        Effect.exit(Fiber.join(write)).pipe(
          Effect.map((exit) =>
            Exit.isSuccess(exit) ? "succeeded" : String(Cause.squash(exit.cause)),
          ),
        ),
        Effect.sleep(1000).pipe(Effect.as("deadline exceeded" as const)),
      );
      // Session shutdown owns this cancellation; it is not a failed daemon operation.
      expect(writeResult).toBe("succeeded");
    } finally {
      yield* Effect.promise(() =>
        Promise.race([
          S(daemon),
          Bun.sleep(1000).then(() => {
            throw new Error("daemon stop deadline exceeded");
          }),
        ]),
      );
    }
  }),
);

testEffect("daemon shutdown is bounded when session children trap termination signals", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const daemon = yield* Effect.promise(() => open("trapped-shutdown", e));
    // started by startDaemon;
    const marker = nodeJoin(e.HOME!, "children");
    yield* daemon.spawnSession({
      id: "trapped",
      cmd: [
        "bash",
        "-c",
        `trap '' HUP TERM; printf '%s\\n' "$BASHPID" > ${marker}; (trap '' HUP TERM; printf '%s\\n' "$BASHPID" >> ${marker}; sleep 30) & wait`,
      ],
      cols: 80,
      rows: 24,
    });
    yield* Effect.promise(() =>
      waitFor(
        () =>
          readFile(marker, "utf8").then(
            (text) => text.trim().split("\n").length >= 2,
            () => false,
          ),
        "the shell and its child to report their pids",
        2_000,
      ),
    );
    const pids = (yield* Effect.promise(() => readFile(marker, "utf8")))
      .trim()
      .split("\n")
      .map(Number);
    expect(pids).toHaveLength(2);

    // Shutdown must finish before the race budget; process-gone is the proof
    // that children were reaped — not a second Date.now() assert.
    yield* Effect.promise(() =>
      Promise.race([
        S(daemon),
        Bun.sleep(5_000).then(() => {
          throw new Error("bounded daemon shutdown deadline exceeded");
        }),
      ]),
    );
    for (const pid of pids) yield* Effect.promise(() => expectProcessGone(pid));
  }),
);

// =============================================================================
// From attachhost.test.ts
// =============================================================================

testEffect("hello is honoured alongside frames batched behind it in one write", () =>
  Effect.gen(function* () {
    const daemon = yield* started("batched");
    yield* daemon.spawnSession({ id: "agent-1", cmd: ["cat"], cols: 80, rows: 24 });

    const attached = yield* Effect.promise(() =>
      client(
        daemon.paths.attach,
        "batcher",
        encodeAttachFrame({
          _tag: "input",
          session: "agent-1",
          data: new TextEncoder().encode("echoed\n"),
        }),
      ),
    );
    // `cat` echoes its input back, so seeing it proves the input frame was read
    // rather than stranded behind the hello.
    yield* until(() => text(attached.frames).includes("echoed"), "cat to echo the batched input");
    attached.socket.end();
  }),
);

testEffect("multiple clients hold independent attachments", () =>
  Effect.gen(function* () {
    const daemon = yield* started("shared");
    const first = yield* Effect.promise(() => client(daemon.paths.attach, "one"));
    yield* until(
      () => Effect.map(daemon.getAttachedClients, (c) => c.includes("one")),
      "the first client to attach",
    );

    const second = yield* Effect.promise(() => client(daemon.paths.attach, "two"));
    // Both, not "whichever arrived first": there is no owner to name any more.
    yield* until(
      () => Effect.map(daemon.getAttachedClients, (c) => [...c].sort().join(",") === "one,two"),
      "both clients to attach",
    );
    expect(second.frames.some((f) => f._tag === "error")).toBe(false);

    first.socket.end();
    // The survivor keeps the session attached, and it is specifically the one
    // that did NOT leave — asserting `attached` alone would also pass if the
    // release had wiped both and something else had re-attached.
    yield* until(
      () => Effect.map(daemon.getAttachedClients, (c) => c.join(",") === "two"),
      "the leaving client to release, the survivor to remain",
    );
    expect((yield* daemon.getState).attached).toBe(true);
    second.socket.end();
    yield* until(
      () => Effect.map(daemon.getAttachedClient, (c) => c === null),
      "the last client to detach",
    );
  }),
);

testEffect("a reconnect with the same client id cannot be released by the old socket", () =>
  Effect.gen(function* () {
    const daemon = yield* started("same-client-reconnect");
    const first = yield* Effect.promise(() => client(daemon.paths.attach, "stable"));
    yield* until(
      () => Effect.map(daemon.getAttachedClient, (c) => c === "stable"),
      "the first connection to attach",
    );

    first.socket.end();
    const second = yield* Effect.promise(() => client(daemon.paths.attach, "stable"));
    second.socket.write(encodeAttachFrame({ _tag: "ping", nonce: "replacement-alive" }));
    yield* until(
      () => second.frames.some((f) => f._tag === "pong" && f.nonce === "replacement-alive"),
      "the reconnected socket to answer a ping",
    );
    expect(yield* daemon.getAttachedClient).toBe("stable");
    expect(second.frames.some((frame) => frame._tag === "error")).toBe(false);
    second.socket.end();
  }),
);

testEffect("an input naming a dead session is ignored rather than dropping the attachment", () =>
  Effect.gen(function* () {
    const daemon = yield* started("stale-input");
    const attached = yield* Effect.promise(() => client(daemon.paths.attach, "racer"));
    yield* until(
      () => Effect.map(daemon.getAttachedClient, (c) => c === "racer"),
      "the client to attach",
    );

    attached.socket.write(
      encodeAttachFrame({
        _tag: "input",
        session: "agent-that-never-was",
        data: new TextEncoder().encode("x"),
      }),
    );
    attached.socket.write(encodeAttachFrame({ _tag: "ping", nonce: "alive" }));
    // Still attached: a keystroke in flight when a process exits is a race, not
    // a protocol violation, and must not take the whole connection down. The
    // ping answered proves it — a dropped connection would never reply.
    yield* until(
      () => attached.frames.some((f) => f._tag === "pong" && f.nonce === "alive"),
      "a ping sent after the stale input to be answered",
    );
    expect(yield* daemon.getAttachedClient).toBe("racer");
    attached.socket.end();
  }),
);

testEffect("stopping the daemon closes the attach socket and its sessions", () =>
  Effect.gen(function* () {
    const daemon = yield* started("teardown");
    const pty = yield* daemon.spawnSession({
      id: "agent-1",
      cmd: ["sleep", "30"],
      cols: 80,
      rows: 24,
    });
    const path = daemon.paths.attach;

    yield* daemon.stop;
    daemons.splice(daemons.indexOf(daemon), 1);

    yield* Effect.promise(() =>
      Bun.connect({ unix: path, socket: { data() {} } }).then(
        () => Promise.reject(new Error("attach socket unexpectedly accepted a connection")),
        () => undefined,
      ),
    );
    // The scope that owned the PTY is gone, so the process it was supervising is
    // gone with it rather than being orphaned. `sleep 30` would still be running
    // if the finalizer had not fired.
    const exited = yield* Effect.race(
      pty.exit.pipe(Effect.as("exited" as const)),
      Effect.sleep(2000).pipe(Effect.as("orphaned" as const)),
    );
    expect(exited).toBe("exited");
  }),
);

testEffect("closing a daemon persists that the preserved session is detached", () =>
  Effect.gen(function* () {
    const daemon = yield* started("close-detached");
    const attached = yield* Effect.promise(() => client(daemon.paths.attach, "watcher"));
    yield* until(
      () => Effect.map(daemon.getAttachedClient, (c) => c === "watcher"),
      "the watcher to attach",
    );

    yield* daemon.close;
    daemons.splice(daemons.indexOf(daemon), 1);
    attached.socket.end();

    const home = attachEnvs.get(daemon.id)!.HOME!;
    expect(
      (yield* Effect.promise(() =>
        attachRun(
          Effect.flatMap(SessionStore, (store) => store.load("close-detached")),
          {
            HOME: home,
            XDG_STATE_HOME: pathJoin(home, "state"),
          },
        ),
      ))?.attached,
    ).toBe(false);
  }),
);

// =============================================================================
// From git-worktree.test.ts
// =============================================================================

test("space.new with a branch creates a worktree under the daemon's worktrees root", async () => {
  const repo = await initRepo();
  const e = await env("wt");
  const daemon = await wtOpen("wt-new", e);
  try {
    const worktreesRoot = nodeJoin(e.HOME!, "wt");
    await mkdir(worktreesRoot);
    const context = {
      size: { cols: 80, rows: 24 },
      shell: ["sh"],
      cwd: "/tmp",
      worktreesRoot,
    };
    const before = ws(daemon).revision;
    await runCommand(
      daemon,
      command("space.new", { branch: "feat/demo", dir: repo, base: "main" }),
      before,
      context,
    );
    const space = ws(daemon).spaces.find((s) => s.worktree?.branch === "feat/demo");
    expect(space).toBeDefined();
    const worktree = space!.worktree!;
    expect(worktree.repo).toBe(repo);
    // The client's worktreesRoot is advisory: the daemon resolves the real root
    // from its own env (XDG_STATE_HOME), never from a client-supplied path.
    expect(worktree.path).toBe(
      nodeJoin(
        e.XDG_STATE_HOME!,
        "amux",
        "worktrees",
        `${space!.id}-${worktreeDirname("feat/demo")}`,
      ),
    );
    expect(await gitWorktreeExists(worktree.path)).toBe(true);
  } finally {
    await close(daemon);
  }
});

test("a failed space.new leaves no worktree behind", async () => {
  const repo = await initRepo();
  const e = await env("wt");
  const daemon = await wtOpen("wt-failed-new", e);
  const worktreesRoot = nodeJoin(e.HOME!, "wt");
  await mkdir(worktreesRoot);
  const context = {
    size: { cols: 80, rows: 24 },
    shell: ["sh"],
    cwd: "/tmp",
    worktreesRoot,
  };

  const revision = ws(daemon).revision;
  // An unresolvable base fails `git worktree add`, which aborts the transaction
  // before the space is committed.
  await expect(
    runCommand(
      daemon,
      command("space.new", { branch: "feat/new", dir: repo, base: "no-such-base" }),
      revision,
      context,
    ),
  ).rejects.toThrow();

  const orphan = nodeJoin(worktreesRoot, `${"anything"}-${worktreeDirname("feat/new")}`);
  expect(await gitWorktreeExists(orphan)).toBe(false);
  const spaces = await readFile(
    nodeJoin(e.XDG_STATE_HOME!, "amux", "sessions", "wt-failed-new", "session.json"),
    "utf8",
  );
  expect(spaces).not.toContain("feat/new");
  await close(daemon);
});
