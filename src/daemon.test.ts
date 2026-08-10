import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Schema, Scope, Stream } from "effect";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import {
  makeDaemonService,
  startDaemon,
  DaemonError,
  type SessionDaemonOptions,
  type SessionDaemonService,
} from "./daemon.ts";
import { SessionStore, sessionPaths } from "./session.ts";
import { command } from "./commands.ts";
import { MAX_RPC_BYTES } from "./limits.ts";
import { AttachClient } from "./attach.ts";
import { controlCall, type ControlClient } from "./control-client.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function env() {
  const home = await mkdtemp(join(tmpdir(), "amux-daemon-"));
  dirs.push(home);
  return { HOME: home, XDG_STATE_HOME: join(home, "state") };
}

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Scope.Scope>,
  e: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(SessionStore.Default),
        Effect.provide(BunFileSystem.layer),
        Effect.withConfigProvider(ConfigProvider.fromJson(e)),
      ),
    ),
  );
const open = (id: string, e: NodeJS.ProcessEnv, options?: SessionDaemonOptions) =>
  run(startDaemon(id, options), e);
const paths = (id: string, e: NodeJS.ProcessEnv) => run(sessionPaths(id), e);
const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

const st = (d: SessionDaemonService) => Effect.runSync(d.getState);
const ws = (d: SessionDaemonService) => Effect.runSync(d.getWorkspace);
const S = (d: SessionDaemonService) => Effect.runPromise(d.stop);
const C = (d: SessionDaemonService) => Effect.runPromise(d.close);
const rwc =
  (d: SessionDaemonService) =>
  async (
    value: Parameters<SessionDaemonService["runWorkspaceCommand"]>[0],
    rev: Parameters<SessionDaemonService["runWorkspaceCommand"]>[1],
    ctx: Parameters<SessionDaemonService["runWorkspaceCommand"]>[2],
  ) =>
    Effect.runPromise(d.runWorkspaceCommand(value, rev, ctx));
/** One control-plane request over the daemon's real Unix socket. */
const ctl = <A, E>(
  id: string,
  e: NodeJS.ProcessEnv,
  use: (control: ControlClient) => Effect.Effect<A, E>,
) => run(controlCall(id, use), e);

const status = (d: SessionDaemonService, e: NodeJS.ProcessEnv) =>
  ctl(d.id, e, (control) => control.Status());

/** The daemon reports itself healthy: no heartbeat or durability complaint. */
const healthy = async (d: SessionDaemonService, e: NodeJS.ProcessEnv) =>
  (await status(d, e)).degraded === undefined;

const saveEffect = (save: (state: any, signal: AbortSignal) => Promise<void>) => (state: any) =>
  Effect.tryPromise({
    try: (signal) => save(state, signal),
    catch: (error) =>
      new DaemonError({ message: error instanceof Error ? error.message : String(error) }),
  });

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const pid = Number(await readFile(path, "utf8").catch(() => ""));
    if (Number.isInteger(pid) && pid > 0) return pid;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for pid in ${path}`);
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(`/proc/${pid}/stat`);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  await expect(readFile(`/proc/${pid}/stat`)).rejects.toThrow();
}

test("concurrent opens reject the second owner and release on stop", async () => {
  const e = await env();
  const first = await open("race", e);
  await expect(open("race", e)).rejects.toThrow(/already (being opened|owned)/);
  await expect(open("race", e)).rejects.toThrow(/already (being opened|owned)/);
  await S(first);
  expect(await run(SessionStore.load("race"), e)).toBeNull();
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
    SessionStore.writeLease({
      version: 1,
      session: "restart",
      pid: 999999,
      socket: p.socket,
      startedAt: 1,
      heartbeatAt: 1,
    }),
    e,
  );
  const d = await open("restart", e);
  expect(st(d).id).toBe("restart");
  expect(st(d).attached).toBe(false);
  await S(d);
});

test("an empty lock is not stolen — the daemon retries until the claimant finishes writing", async () => {
  const e = await env();
  const p = await run(sessionPaths("contended"), e);
  await mkdir(p.root, { recursive: true });
  // Simulate a concurrent process that opened the lock with wx but hasn't
  // written its PID yet: the lock file exists but is empty.
  await writeFile(p.lock, "");

  const opening = (async () => {
    const d = await open("contended", e);
    return d;
  })();

  // The daemon should retry, not immediately error or steal the lock.
  await Bun.sleep(100);
  await expect(Promise.race([opening, Promise.resolve("retrying")])).resolves.toBe("retrying");

  // Remove the contended lock so the daemon can acquire it.
  await rm(p.lock);
  const daemon = await opening;
  expect(st(daemon).id).toBe("contended");
  await S(daemon);
});

test("a post-acquisition lease check releases the lock so the next start can proceed", async () => {
  const e = await env();
  const p = await run(sessionPaths("released"), e);
  await mkdir(p.root, { recursive: true });
  await writeFile(p.state, JSON.stringify({
    version: 1,
    id: "released",
    createdAt: 1,
    updatedAt: 1,
    attached: false,
    spaces: [],
  }));
  // Write a lease with our own PID — the daemon will acquire the lock (wx
  // succeeds because no lock exists) but then the lease check must fail
  // because processAlive(process.pid) returns true.
  await run(SessionStore.writeLease({
    version: 1,
    session: "released",
    pid: process.pid,
    socket: p.socket,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
  }), e);

  await expect(open("released", e)).rejects.toThrow(/already owned by pid/);

  // The lock was acquired then released on failure — the file must be gone.
  await expect(Bun.file(p.lock).exists()).resolves.toBe(false);
});

test("a competing acquisition that detects a live owner never deletes the owner's lock", async () => {
  const e = await env();
  const p = await run(sessionPaths("donotdelete"), e);
  await mkdir(p.root, { recursive: true });
  // Simulate a live daemon holding the lock.
  await writeFile(p.lock, `${process.pid}\n`);
  await writeFile(p.state, JSON.stringify({
    version: 1,
    id: "donotdelete",
    createdAt: 1,
    updatedAt: 1,
    attached: false,
    spaces: [],
  }));

  await expect(
    run(makeDaemonService("donotdelete", {}), e),
  ).rejects.toThrow(/already being opened/);

  // The holder's lock file must still exist and be unmodified.
  await expect(Bun.file(p.lock).exists()).resolves.toBe(true);
  expect(await readFile(p.lock, "utf8")).toBe(`${process.pid}\n`);
});

test("cleanup leaves a locked startup session for its owner", async () => {
  const e = await env();
  const p = await run(sessionPaths("starting"), e);
  await Bun.write(
    p.state,
    JSON.stringify({
      version: 1,
      id: "starting",
      createdAt: 1,
      updatedAt: 1,
      attached: false,
      spaces: [],
    }),
  );
  await writeFile(p.lock, `${process.pid}\n`);
  expect(await run(SessionStore.cleanupStale, e)).toEqual([]);
  expect(await run(SessionStore.load("starting"), e)).not.toBeNull();
});

test("the daemon-owned workspace survives closing and reopening", async () => {
  const e = await env();
  const first = await open("workspace", e);
  await rwc(first)(command("space.rename", { name: "proj" }), ws(first).revision, context);
  await rwc(first)(command("window.rename", { name: "build" }), ws(first).revision, context);
  await C(first);

  const second = await open("workspace", e);
  const window = st(second).spaces[0]!.windows[0]!;
  expect(st(second).activeSpace).toBe(st(second).spaces[0]!.id);
  expect(st(second).spaces[0]!.name).toBe("proj");
  expect(window.name).toBe("build");
  expect(window.layout).toContain("agent-");
  expect(st(second).attached).toBe(false);
  await C(second);
});

test("a new session starts with a default 80x24 space", async () => {
  const e = await env();
  const d = await open("default-size", e);
  const space = ws(d).spaces[0]!;
  const window = space.windows[0]!;
  expect(window.layout.root).toBeDefined();
  expect(window.agents[0]?.cols).toBe(80);
  expect(window.agents[0]?.rows).toBe(24);
  await C(d);
});

test("last pane removal closes the daemon so the next attach starts fresh", async () => {
  const e = await env();
  const d = await open("empty", e);
  await rwc(d)(command("space.close", { space: ws(d).spaces[0]!.id }), ws(d).revision, context);
  await Bun.sleep(100);
  expect(await run(SessionStore.readLease("empty"), e)).toBeNull();
  const next = await open("empty", e);
  const nextWorkspace = await Effect.runPromise(next.getWorkspace);
  expect(nextWorkspace.spaces).toHaveLength(1);
  expect(nextWorkspace.spaces[0]!.windows[0]!.agents[0]!.exited).toBe(false);
  await C(next);
});

test("stopping a daemon discards the workspace it was keeping", async () => {
  const e = await env();
  const d = await open("discard", e);
  await S(d);
  expect(await run(SessionStore.load("discard"), e)).toBeNull();
});

test("stopping waits for an in-flight workspace mutation before removing metadata", async () => {
  const e = await env();
  const d = await open("stop-save-race", e);
  const save = rwc(d)(command("space.rename", { name: "p" }), ws(d).revision, context);
  const stop = S(d);
  await Promise.all([save, stop]);
  expect(await run(SessionStore.load("stop-save-race"), e)).toBeNull();
});

test("the daemon rejects a stale client instead of rebasing its command", async () => {
  const e = await env();
  const d = await open("stale-model", e);
  const stale = ws(d).revision;
  await rwc(d)(command("space.rename", { name: "winner" }), stale, context);
  await expect(rwc(d)(command("space.rename", { name: "loser" }), stale, context)).rejects.toThrow(
    "stale workspace revision",
  );
  expect(ws(d).spaces[0]!.name).toBe("winner");
  await S(d);
});

test("the control plane exposes no unrevisioned spawn or kill procedure", async () => {
  const e = await env();
  const d = await open("no-bypass", e);
  const before = await Effect.runPromise(d.liveSessions());
  // The group is the whole surface: anything outside it is refused by the
  // server before a handler exists to run it.
  await expect(ctl(d.id, e, (c) => (c as any).Spawn({}))).rejects.toThrow();
  expect(await Effect.runPromise(d.liveSessions())).toEqual(before);
  await S(d);
});

test("RPC rejects aggregate command bodies before decoding their payload", async () => {
  const e = await env();
  const d = await open("bounded-rpc", e);
  // The NDJSON framer tears the connection down before the oversized line is
  // ever parsed, so an over-limit request fails rather than being served.
  await expect(
    ctl("bounded-rpc", e, (c) => c.SetBuffer({ data: "x".repeat(MAX_RPC_BYTES) })),
  ).rejects.toThrow();
  // The daemon is still serving afterwards.
  expect(await healthy(d, e)).toBe(true);
  await S(d);
});

test("a persistence failure compensates a spawned PTY and installs no generation", async () => {
  const e = await env();
  const d = await open("persist-transaction", e);
  const before = ws(d);
  const beforeLive = await Effect.runPromise(d.liveSessions());
  const p = await paths("persist-transaction", e);
  await rm(p.backup, { recursive: true, force: true });
  await mkdir(p.backup);

  await expect(
    rwc(d)(command("pane.split", { axis: "row" }), before.revision, context),
  ).rejects.toThrow();
  expect(ws(d)).toEqual(before);
  expect(await Effect.runPromise(d.liveSessions())).toEqual(beforeLive);
  await S(d);
});

test("a fast prepared exit cannot deadlock failed-write compensation", async () => {
  const e = await env();
  const marker = join(e.HOME!, "fast-exited");
  let rejectCandidate = true;
  const daemon = await open("fast-compensation", e, {
    saveState: saveEffect(async (state: any) => {
      const agents = state.spaces.flatMap((space: any) =>
        space.windows.flatMap((window: any) => window.agents),
      );
      if (rejectCandidate && agents.length > 1) {
        const deadline = Date.now() + 1_000;
        while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(5);
        await Bun.sleep(50);
        throw new Error("injected candidate failure");
      }
      await run(SessionStore.save(state), e);
    }),
  });
  // started by startDaemon;
  const before = ws(daemon);
  await expect(
    Promise.race([
      rwc(daemon)(command("pane.split", { axis: "row" }), before.revision, {
        ...context,
        shell: ["sh", "-c", `printf exited > ${marker}`],
      }),
      Bun.sleep(1_000).then(() => {
        throw new Error("compensation deadlocked");
      }),
    ]),
  ).rejects.toThrow("injected candidate failure");
  expect(await Bun.file(marker).text()).toBe("exited");
  expect(ws(daemon)).toEqual(before);
  expect(await Effect.runPromise(daemon.liveSessions())).toHaveLength(1);
  rejectCandidate = false;
  await S(daemon);
});

test("a prepared session is absent from status and subscribers until its model is durable", async () => {
  const e = await env();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saving!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    saving = resolve;
  });
  let preparedId = "";
  const daemon = await open("private-prepare", e, {
    saveState: saveEffect(async (state: any) => {
      const agents = state.spaces.flatMap((space: any) =>
        space.windows.flatMap((window: any) => window.agents),
      );
      if (agents.length > 1) {
        preparedId = agents.at(-1).id;
        saving();
        await gate;
      }
      await run(SessionStore.save(state), e);
    }),
  });
  // started by startDaemon;
  const p = await paths("private-prepare", e);
  const subscriber = await AttachClient.connect({ path: p.attach, client: "subscriber" });
  const beforeLive = await Effect.runPromise(daemon.liveSessions());
  const model = Effect.runPromise(Stream.runHead(subscriber.workspace()));
  const commandRun = rwc(daemon)(command("pane.split", { axis: "row" }), ws(daemon).revision, {
    ...context,
    shell: ["sh", "-c", "printf private; sleep 30"],
  });
  await saveStarted;
  // Let the private child produce output before acquiring a stream. If the hub
  // leaked it, AttachClient would already have created an unknown-session queue
  // and runHead would consume that stale frame immediately.
  await Bun.sleep(30);
  const terminal = Effect.runPromise(Stream.runHead(subscriber.stream(preparedId)));
  const live = await status(daemon, e);
  expect(live.agents).toEqual([...beforeLive]);
  expect(await Effect.runPromise(daemon.liveSessions())).toEqual(beforeLive);
  expect(
    await Promise.race([model.then(() => "published"), Bun.sleep(30).then(() => "private")]),
  ).toBe("private");
  expect(
    await Promise.race([terminal.then(() => "published"), Bun.sleep(30).then(() => "private")]),
  ).toBe("private");

  release();
  await commandRun;
  expect((await model)._tag).toBe("Some");
  expect((await terminal)._tag).toBe("Some");
  subscriber.close();
  await S(daemon);
});

test("a one-shot reversible write failure does not poison the next command", async () => {
  const e = await env();
  let fail = true;
  const daemon = await open("candidate-recovery", e, {
    saveState: saveEffect(async (state: any) => {
      const agents = state.spaces.flatMap((space: any) =>
        space.windows.flatMap((window: any) => window.agents),
      );
      if (fail && agents.length > 1) {
        fail = false;
        throw new Error("one-shot candidate failure");
      }
      await run(SessionStore.save(state), e);
    }),
  });
  // started by startDaemon;
  const revision = ws(daemon).revision;
  await expect(
    rwc(daemon)(command("pane.split", { axis: "row" }), revision, context),
  ).rejects.toThrow("one-shot candidate failure");
  expect(await healthy(daemon, e)).toBe(true);
  const recovered = await rwc(daemon)(command("pane.split", { axis: "row" }), revision, context);
  expect(recovered.spaces[0]!.windows[0]!.agents).toHaveLength(2);
  await S(daemon);
});

test("a rejected candidate never reaches current or backup state", async () => {
  const e = await env();
  let rejectCandidate = true;
  const daemon = await open("no-rollback", e, {
    saveState: saveEffect(async (state: any) => {
      const agents = state.spaces.flatMap((space: any) =>
        space.windows.flatMap((window: any) => window.agents),
      );
      if (rejectCandidate && agents.length > 1) throw new Error("injected candidate failure");
      await run(SessionStore.save(state), e);
    }),
  });
  // started by startDaemon;
  await expect(
    rwc(daemon)(command("pane.split", { axis: "row" }), ws(daemon).revision, context),
  ).rejects.toThrow("injected candidate failure");
  rejectCandidate = false;
  await C(daemon);

  const reopened = await open("no-rollback", e);
  const agents = st(reopened).spaces.flatMap((space) =>
    space.windows.flatMap((window) => window.agents),
  );
  expect(agents).toHaveLength(1);
  await S(reopened);
});

test("attachment metadata cannot overwrite a newer workspace generation", async () => {
  const e = await env();
  let releaseAttach!: () => void;
  const attachGate = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  let attachStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    attachStarted = resolve;
  });
  let detachStarted!: () => void;
  const detaching = new Promise<void>((resolve) => {
    detachStarted = resolve;
  });
  let releaseDetach!: () => void;
  const detachGate = new Promise<void>((resolve) => {
    releaseDetach = resolve;
  });
  let blockAttach = true;
  let blockDetach = false;
  const daemon = await open("attach-write-race", e, {
    saveState: saveEffect(async (state: any) => {
      if (blockAttach && state.attached) {
        attachStarted();
        await attachGate;
      }
      if (blockDetach && !state.attached) {
        detachStarted();
        await detachGate;
      }
      await run(SessionStore.save(state), e);
    }),
  });
  // started by startDaemon;
  const p = await paths("attach-write-race", e);
  const attaching = AttachClient.connect({ path: p.attach, client: "race" });
  await started;
  let renamed = false;
  const rename = rwc(daemon)(
    command("space.rename", { name: "winner" }),
    ws(daemon).revision,
    context,
  ).then(() => {
    renamed = true;
  });
  await Bun.sleep(20);
  expect(renamed).toBe(false);
  releaseAttach();
  const client = await attaching;
  await rename;
  const saved = await run(SessionStore.load("attach-write-race"), e);
  expect(saved?.attached).toBe(true);
  expect(saved?.spaces[0]?.name).toBe("winner");
  blockAttach = false;
  blockDetach = true;
  client.close();
  await detaching;
  const secondRename = rwc(daemon)(
    command("space.rename", { name: "newest" }),
    ws(daemon).revision,
    context,
  );
  releaseDetach();
  await secondRename;
  const detached = await run(SessionStore.load("attach-write-race"), e);
  expect(detached?.attached).toBe(false);
  expect(detached?.spaces[0]?.name).toBe("newest");
  blockDetach = false;
  await S(daemon);
});

test("a destructive commit retries its single durable write after process completion", async () => {
  const e = await env();
  let armed = false;
  let failed = false;
  const daemon = await open("kill-write-retry", e, {
    saveState: saveEffect(async (state: any) => {
      if (armed && !failed && state.spaces.length === 0) {
        failed = true;
        throw new Error("transient destructive write failure");
      }
      await run(SessionStore.save(state), e);
    }),
  });
  // started by startDaemon;
  armed = true;
  const agent = ws(daemon).spaces[0]!.windows[0]!.agents[0]!.id;
  await rwc(daemon)(command("session.kill", { session: agent }), ws(daemon).revision, context);
  expect(failed).toBe(true);
  expect(ws(daemon).spaces).toHaveLength(0);
  await Bun.sleep(100);
  expect(await run(SessionStore.readLease("kill-write-retry"), e)).toBeNull();
});

test("stop interrupts and joins a never-settling destructive persistence operation", async () => {
  const e = await env();
  let armed = false;
  let saving!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    saving = resolve;
  });
  let cancelled = false;
  const daemon = await open("kill-save-cancel", e, {
    saveState: (state) => {
      if (armed && state.spaces.length === 0) {
        saving();
        return Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              cancelled = true;
            }),
          ),
        );
      }
      return SessionStore.save(state);
    },
  });
  // started by startDaemon;
  const marker = join(e.HOME!, "held-destructive-pid");
  await Effect.runPromise(
    daemon.spawnSession({
      id: "held-destructive",
      cmd: ["sh", "-c", `printf '%s' $$ > ${marker}; sleep 30`],
      cols: 80,
      rows: 24,
    }),
  );
  const heldPid = await waitForPid(marker);
  armed = true;
  const agent = ws(daemon).spaces[0]!.windows[0]!.agents[0]!.id;
  const mutation = rwc(daemon)(command("session.kill", { session: agent }), ws(daemon).revision, context);
  void mutation.catch(() => {});
  await saveStarted;
  const started = Date.now();
  await Promise.race([
    S(daemon),
    Bun.sleep(1_500).then(() => {
      throw new Error("stop did not interrupt destructive persistence");
    }),
  ]);
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(cancelled).toBe(true);
  await expect(mutation).rejects.toThrow();
  expect(await Effect.runPromise(daemon.liveSessions())).toEqual([]);
  expect(await run(SessionStore.load("kill-save-cancel"), e)).toBeNull();
  await expectProcessGone(heldPid);
});

test("the first heartbeat waits one interval after the startup lease write", async () => {
  const e = await env();
  const daemon = await open("heartbeat-first-fire", e);
  // started by startDaemon;
  const initial = await run(SessionStore.readLease("heartbeat-first-fire"), e);
  expect(initial).not.toBeNull();

  await Bun.sleep(700);
  expect((await run(SessionStore.readLease("heartbeat-first-fire"), e))?.heartbeatAt).toBe(
    initial!.heartbeatAt,
  );

  const firstBeatBy = Date.now() + 1_000;
  let heartbeatAt = initial!.heartbeatAt;
  while (heartbeatAt === initial!.heartbeatAt && Date.now() < firstBeatBy) {
    await Bun.sleep(10);
    heartbeatAt = (await run(SessionStore.readLease("heartbeat-first-fire"), e))!.heartbeatAt;
  }
  expect(heartbeatAt).toBeGreaterThan(initial!.heartbeatAt);
  await C(daemon);
});

test("a heartbeat queued behind attachment persistence publishes the committed attachment", async () => {
  const e = await env();
  let releaseAttach!: () => void;
  const attachGate = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  let attachStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    attachStarted = resolve;
  });
  let blockAttach = true;
  const daemon = await open("heartbeat-attach-race", e, {
    saveState: saveEffect(async (state: any) => {
      if (blockAttach && state.attached) {
        attachStarted();
        await attachGate;
      }
      await run(SessionStore.save(state), e);
    }),
  });
  // started by startDaemon;
  const initial = await run(SessionStore.readLease("heartbeat-attach-race"), e);
  const p = await paths("heartbeat-attach-race", e);
  const connecting = AttachClient.connect({ path: p.attach, client: "lease-race" });
  await started;

  // The first scheduled beat is now queued behind the blocked attachment.
  await Bun.sleep(1_100);
  releaseAttach();
  const client = await connecting;
  const heartbeatBy = Date.now() + 1_000;
  let lease = await run(SessionStore.readLease("heartbeat-attach-race"), e);
  while (lease?.heartbeatAt === initial?.heartbeatAt && Date.now() < heartbeatBy) {
    await Bun.sleep(10);
    lease = await run(SessionStore.readLease("heartbeat-attach-race"), e);
  }
  expect(lease?.attachments).toEqual([expect.objectContaining({ client: "lease-race" })]);

  blockAttach = false;
  client.close();
  await S(daemon);
});

test("heartbeat failure is visible and the heartbeat stops with the daemon scope", async () => {
  const e = await env();
  const daemon = await open("heartbeat-scope", e);
  // started by startDaemon;
  const p = await paths("heartbeat-scope", e);
  await rm(p.lease, { force: true });
  await mkdir(p.lease);

  const failedBy = Date.now() + 3_500;
  let report = await status(daemon, e);
  while (report.degraded === undefined && Date.now() < failedBy) {
    await Bun.sleep(10);
    report = await status(daemon, e);
  }
  expect(report.degraded).toContain("lease heartbeat failed");

  await rm(p.lease, { recursive: true, force: true });
  const recoveredBy = Date.now() + 3_500;
  while (!(await healthy(daemon, e)) && Date.now() < recoveredBy) await Bun.sleep(10);
  expect(await healthy(daemon, e)).toBe(true);

  await C(daemon);
  await Bun.sleep(1_100);
  expect(await Bun.file(p.lease).exists()).toBe(false);
});

test("close bounds and interrupts its final persistence obligation", async () => {
  const e = await env();
  let armed = false;
  let cancelled = false;
  const daemon = await open("bounded-final-save", e, {
    saveState: (state) =>
      armed && !state.attached
        ? Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
          )
        : SessionStore.save(state),
  });
  // started by startDaemon;
  armed = true;

  const started = Date.now();
  await expect(C(daemon)).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(cancelled).toBe(true);

  const replacement = await open("bounded-final-save", e);
  await S(replacement);
});

test("a transient natural-exit write failure retries before making the exit visible", async () => {
  const e = await env();
  let failed = false;
  const daemon = await open("exit-retry", e, {
    saveState: saveEffect(async (state: any) => {
      const exited = state.spaces
        .flatMap((space: any) => space.windows)
        .flatMap((window: any) => window.agents)
        .some((agent: any) => agent.exited);
      if (exited && !failed) {
        failed = true;
        throw new Error("transient disk failure");
      }
      await run(SessionStore.save(state), e);
    }),
  });
  // started by startDaemon;
  await rwc(daemon)(command("pane.split", { axis: "row" }), ws(daemon).revision, {
    ...context,
    shell: ["sh", "-c", "exit 7"],
  });
  const deadline = Date.now() + 2_000;
  while (
    !ws(daemon).spaces[0]!.windows[0]!.agents.some((agent) => agent.exited) &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10);
  }
  expect(failed).toBe(true);
  expect(
    ws(daemon).spaces[0]!.windows[0]!.agents.some((agent) => agent.exited && agent.exitCode === 7),
  ).toBe(true);
  expect(await healthy(daemon, e)).toBe(true);
  await S(daemon);
});

test("permanent natural-exit persistence failure surfaces unhealthy status until recovery", async () => {
  const e = await env();
  let unavailable = true;
  const daemon = await open("exit-unhealthy", e, {
    saveState: saveEffect(async (state: any) => {
      const exited = state.spaces
        .flatMap((space: any) => space.windows)
        .flatMap((window: any) => window.agents)
        .some((agent: any) => agent.exited);
      if (exited && unavailable) throw new Error("disk offline");
      await run(SessionStore.save(state), e);
    }),
  });
  // started by startDaemon;
  await rwc(daemon)(command("pane.split", { axis: "row" }), ws(daemon).revision, {
    ...context,
    shell: ["sh", "-c", "exit 0"],
  });
  const deadline = Date.now() + 2_000;
  let report = await status(daemon, e);
  while (!report.degraded?.includes("disk offline") && Date.now() < deadline) {
    await Bun.sleep(10);
    report = await status(daemon, e);
  }
  expect(report.degraded).toContain("disk offline");
  const p = await paths("exit-unhealthy", e);
  let attached = false;
  const connecting = AttachClient.connect({ path: p.attach, client: "blocked-metadata" }).then(
    (client) => {
      attached = true;
      return client;
    },
  );
  await Bun.sleep(30);
  expect(attached).toBe(false);
  expect(await healthy(daemon, e)).toBe(false);
  unavailable = false;
  const client = await connecting;
  const recovered = Date.now() + 2_000;
  while (!(await healthy(daemon, e)) && Date.now() < recovered) await Bun.sleep(10);
  expect(await healthy(daemon, e)).toBe(true);
  client.close();
  await S(daemon);
});

test("close interrupts and joins a never-settling natural-exit persistence operation", async () => {
  const e = await env();
  let armed = false;
  let saving!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    saving = resolve;
  });
  let cancelled = false;
  const daemon = await open("exit-save-cancel", e, {
    saveState: (state) => {
      const exited = state.spaces
        .flatMap((space) => space.windows)
        .flatMap((window) => window.agents)
        .some((agent) => agent.exited);
      if (armed && exited) {
        saving();
        return Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              cancelled = true;
            }),
          ),
        );
      }
      return SessionStore.save(state);
    },
  });
  // started by startDaemon;
  const marker = join(e.HOME!, "held-natural-pid");
  await Effect.runPromise(
    daemon.spawnSession({
      id: "held-natural",
      cmd: ["sh", "-c", `printf '%s' $$ > ${marker}; sleep 30`],
      cols: 80,
      rows: 24,
    }),
  );
  const heldPid = await waitForPid(marker);
  armed = true;
  await rwc(daemon)(command("pane.split", { axis: "row" }), ws(daemon).revision, {
    ...context,
    shell: ["sh", "-c", "exit 0"],
  });
  await saveStarted;
  const started = Date.now();
  await Promise.race([
    C(daemon),
    Bun.sleep(1_500).then(() => {
      throw new Error("close did not interrupt natural-exit persistence");
    }),
  ]);
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(cancelled).toBe(true);
  expect(await Effect.runPromise(daemon.liveSessions())).toEqual([]);
  await expectProcessGone(heldPid);
});

test("a failed destructive action leaves durable state untouched", async () => {
  const e = await env();
  const daemon = await open("kill-transaction", e);
  // started by startDaemon;
  const before = ws(daemon);
  const agent = before.spaces[0]!.windows[0]!.agents[0]!.id;
  const kill = daemon.killSession.bind(daemon);
  daemon.killSession = () => Effect.fail(new DaemonError({ message: "injected kill failure" }));
  await expect(
    rwc(daemon)(command("session.kill", { session: agent }), before.revision, context),
  ).rejects.toThrow("injected kill failure");
  expect(ws(daemon)).toEqual(before);
  expect(
    (await run(SessionStore.load("kill-transaction"), e))?.spaces[0]?.windows[0]?.agents[0]?.id,
  ).toBe(agent);
  daemon.killSession = kill;
  await S(daemon);
});

test("restore spawn failures are persisted before the daemon accepts clients", async () => {
  const e = await env();
  const layout = JSON.stringify({
    version: 1,
    root: { type: "pane", id: "pane-restore", agent: "agent-restore", weight: 1 },
    focus: "pane-restore",
  });
  await run(
    SessionStore.save({
      version: 1,
      id: "restore-failure",
      createdAt: 1,
      updatedAt: 1,
      attached: false,
      activeSpace: "space-restore",
      spaces: [
        {
          id: "space-restore",
          name: "restore",
          dir: "/tmp",
          activeWindow: 1,
          windows: [
            {
              number: 1,
              name: null,
              layout,
              agents: [
                {
                  id: "agent-restore",
                  name: "bad",
                  cmd: ["bad"],
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
    }),
    e,
  );
  const daemon = await run(
    makeDaemonService("restore-failure", {
    spawnSession: (spec) =>
        spec.id === "agent-restore"
          ? Effect.fail(new DaemonError({ message: "injected restore spawn failure" }))
          : Effect.die(new DaemonError({ message: "unexpected restore spawn" })),
    }),
    e,
  );
  await Effect.runPromise(daemon.start);
  const saved = await run(SessionStore.load("restore-failure"), e);
  expect(JSON.stringify(saved)).not.toContain("agent-restore");
  await S(daemon);
});

test("a blocked daemon write does not starve timers, RPC, or shutdown", async () => {
  const e = await env();
  const daemon = await open("responsive", e);
  // started by startDaemon;
  try {
    const pty = await Effect.runPromise(
      daemon.spawnSession({
        id: "blocked",
        cmd: ["sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      }),
    );
    const write = Effect.runPromise(pty.write("x".repeat(16 * 1024 * 1024)));
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 25);
    const response = await Promise.race([
      ctl("responsive", e, (c) => c.Ping()),
      Bun.sleep(1000).then(() => {
        throw new Error("RPC deadline exceeded");
      }),
    ]);
    expect(response.attached).toBe(false);
    await Bun.sleep(40);
    expect(timerRan).toBe(true);
    await Effect.runPromise(daemon.killSession("blocked"));
    const writeResult = await Promise.race([
      write.then(
        () => "succeeded",
        (error) => String(error),
      ),
      Bun.sleep(1000).then(() => "deadline exceeded"),
    ]);
    // Session shutdown owns this cancellation; it is not a failed daemon operation.
    expect(writeResult).toBe("succeeded");
  } finally {
    await Promise.race([
      S(daemon),
      Bun.sleep(1000).then(() => {
        throw new Error("daemon stop deadline exceeded");
      }),
    ]);
  }
});

test("daemon shutdown is bounded when session children trap termination signals", async () => {
  const e = await env();
  const daemon = await open("trapped-shutdown", e);
  // started by startDaemon;
  const marker = join(e.HOME!, "children");
  await Effect.runPromise(
    daemon.spawnSession({
      id: "trapped",
      cmd: [
        "bash",
        "-c",
        `trap '' HUP TERM; printf '%s\\n' "$BASHPID" > ${marker}; (trap '' HUP TERM; printf '%s\\n' "$BASHPID" >> ${marker}; sleep 30) & wait`,
      ],
      cols: 80,
      rows: 24,
    }),
  );
  const readyUntil = Date.now() + 2_000;
  while (Date.now() < readyUntil) {
    try {
      if ((await readFile(marker, "utf8")).trim().split("\n").length >= 2) break;
    } catch {}
    await Bun.sleep(10);
  }
  const pids = (await readFile(marker, "utf8")).trim().split("\n").map(Number);
  expect(pids).toHaveLength(2);

  const started = Date.now();
  await Promise.race([
    S(daemon),
    Bun.sleep(2_000).then(() => {
      throw new Error("bounded daemon shutdown deadline exceeded");
    }),
  ]);
  expect(Date.now() - started).toBeLessThan(2_000);
  for (const pid of pids) {
    const goneUntil = Date.now() + 2_000;
    while (Date.now() < goneUntil) {
      try {
        await readFile(`/proc/${pid}/stat`);
        await Bun.sleep(10);
      } catch {
        break;
      }
    }
    await expect(readFile(`/proc/${pid}/stat`)).rejects.toThrow();
  }
});
