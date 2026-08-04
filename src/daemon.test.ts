import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import {
  DaemonRequestSchema,
  daemonRequest,
  SessionDaemon,
  type SessionDaemonOptions,
} from "./daemon.ts";
import { Session, SessionEnv, sessionPaths } from "./session.ts";
import { command } from "./commands.ts";
import { AttachClient } from "./attach.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function env() {
  const home = await mkdtemp(join(tmpdir(), "amux-daemon-"));
  dirs.push(home);
  return { HOME: home, XDG_STATE_HOME: join(home, "state") };
}

const run = <A>(
  effect: Effect.Effect<A, unknown, Session | SessionEnv>,
  e: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Session.Default),
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(SessionEnv, e),
    ),
  );
const open = (id: string, e: NodeJS.ProcessEnv, options: SessionDaemonOptions = {}) =>
  run(SessionDaemon.open(id, options), e);
const paths = (id: string, e: NodeJS.ProcessEnv) => run(sessionPaths(id), e);
const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

test("daemon RPC requests are schema-validated", () => {
  expect(Schema.decodeUnknownSync(DaemonRequestSchema)({ command: "status" })).toEqual({
    command: "status",
  });
  expect(() =>
    Schema.decodeUnknownSync(DaemonRequestSchema)({ command: "status", expectedRevision: "1" }),
  ).toThrow();
  expect(() => Schema.decodeUnknownSync(DaemonRequestSchema)({ command: "unknown" })).toThrow();
});

const saveEffect = (save: (state: any, signal: AbortSignal) => Promise<void>) => (state: any) =>
  Effect.tryPromise({ try: (signal) => save(state, signal), catch: (error) => error });

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
  await expect(open("race", e)).rejects.toThrow("already being opened");
  await first.start();
  await expect(open("race", e)).rejects.toThrow(/already (being opened|owned)/);
  await first.stop();
  expect(await run(Session.load("race"), e)).toBeNull();
});

test("a dead lease and stale lock are recovered without deleting state", async () => {
  const e = await env();
  const paths = await run(sessionPaths("restart"), e);
  await Bun.write(
    paths.state,
    JSON.stringify({
      version: 1,
      id: "restart",
      createdAt: 1,
      updatedAt: 1,
      attached: true,
      spaces: [],
    }),
  );
  await writeFile(paths.lock, "999999\n");
  await run(
    Session.writeLease({
      version: 1,
      session: "restart",
      pid: 999999,
      socket: paths.socket,
      startedAt: 1,
      heartbeatAt: 1,
    }),
    e,
  );
  const daemon = await open("restart", e);
  expect(daemon.state.id).toBe("restart");
  expect(daemon.state.attached).toBe(false);
  await daemon.stop();
});

test("cleanup leaves a locked startup session for its owner", async () => {
  const e = await env();
  const paths = await run(sessionPaths("starting"), e);
  await Bun.write(
    paths.state,
    JSON.stringify({
      version: 1,
      id: "starting",
      createdAt: 1,
      updatedAt: 1,
      attached: false,
      spaces: [],
    }),
  );
  await writeFile(paths.lock, `${process.pid}\n`);
  expect(await run(Session.cleanupStale, e)).toEqual([]);
  expect(await run(Session.load("starting"), e)).not.toBeNull();
});

// The workspace is what makes a restart worth surviving: without it a restored
// session knows a shell was running and nothing about where it sat.
test("the daemon-owned workspace survives closing and reopening", async () => {
  const e = await env();
  const first = await open("workspace", e);
  await first.start();
  await first.runWorkspaceCommand(
    command("space.rename", { name: "proj" }),
    first.workspace.revision,
    context,
  );
  await first.runWorkspaceCommand(
    command("window.rename", { name: "build" }),
    first.workspace.revision,
    context,
  );
  await first.close();

  const second = await open("workspace", e);
  const window = second.state.spaces[0]!.windows[0]!;
  expect(second.state.activeSpace).toBe(second.state.spaces[0]!.id);
  expect(second.state.spaces[0]!.name).toBe("proj");
  expect(window.name).toBe("build");
  expect(window.layout).toContain("agent-");
  // Reopening is not reattaching: a restart leaves nobody holding the session.
  expect(second.state.attached).toBe(false);
  await second.close();
});

test("a new session starts with a default 80x24 space", async () => {
  const e = await env();
  const daemon = await open("default-size", e);
  await daemon.start();
  const space = daemon.workspace.spaces[0]!;
  const window = space.windows[0]!;
  expect(window.layout.root).toBeDefined();
  // The default space is created with 80x24 in daemon.ts:210
  // The agent is created with that size
  expect(window.agents[0]?.cols).toBe(80);
  expect(window.agents[0]?.rows).toBe(24);
  await daemon.close();
});

test("concurrent status reads an empty workspace without racing default creation", async () => {
  const e = await env();
  const daemon = await open("empty", e);
  await daemon.start();
  const space = daemon.workspace.spaces[0]!.id;
  await daemon.runWorkspaceCommand(
    command("space.close", { space }),
    daemon.workspace.revision,
    context,
  );
  expect(daemon.workspace.spaces).toHaveLength(0);

  const [first, second] = await Promise.all([
    run(daemonRequest("empty", { command: "status" }), e),
    run(daemonRequest("empty", { command: "status" }), e),
  ]);
  expect(first.ok).toBe(true);
  expect(second.workspace).toEqual(first.workspace);
  expect(first.workspace?.spaces).toHaveLength(0);
  await daemon.stop();
});

// stop() is the deliberate end of a session, not a restart.
test("stopping a daemon discards the workspace it was keeping", async () => {
  const e = await env();
  const daemon = await open("discard", e);
  await daemon.start();
  await daemon.stop();
  expect(await run(Session.load("discard"), e)).toBeNull();
});

test("stopping waits for an in-flight workspace mutation before removing metadata", async () => {
  const e = await env();
  const daemon = await open("stop-save-race", e);
  await daemon.start();

  const save = daemon.runWorkspaceCommand(
    command("space.rename", { name: "p" }),
    daemon.workspace.revision,
    context,
  );
  const stop = daemon.stop();
  await Promise.all([save, stop]);

  expect(await run(Session.load("stop-save-race"), e)).toBeNull();
});

test("the daemon rejects a stale client instead of rebasing its command", async () => {
  const e = await env();
  const daemon = await open("stale-model", e);
  await daemon.start();
  const stale = daemon.workspace.revision;
  await daemon.runWorkspaceCommand(command("space.rename", { name: "winner" }), stale, context);
  await expect(
    daemon.runWorkspaceCommand(command("space.rename", { name: "loser" }), stale, context),
  ).rejects.toThrow("stale workspace revision");
  expect(daemon.workspace.spaces[0]!.name).toBe("winner");
  await daemon.stop();
});

test("unrevisioned spawn and kill RPC commands do not exist", async () => {
  const e = await env();
  const daemon = await open("no-bypass", e);
  await daemon.start();
  const before = await daemon.liveAgents();
  expect((await daemon.handle({ command: "spawn" } as any)).error).toBe("unknown command");
  expect((await daemon.handle({ command: "kill" } as any)).error).toBe("unknown command");
  expect(await daemon.liveAgents()).toEqual(before);
  await daemon.stop();
});

test("RPC rejects aggregate command bodies before decoding their payload", async () => {
  const e = await env();
  const daemon = await open("bounded-rpc", e);
  await daemon.start();
  const response = await run(
    daemonRequest("bounded-rpc", {
      command: "set-buffer",
      bufferData: "x".repeat(1_048_577),
    }),
    e,
  );
  expect(response.ok).toBe(false);
  expect(response.error).toContain("too large");
  await daemon.stop();
});

test("a persistence failure compensates a spawned PTY and installs no generation", async () => {
  const e = await env();
  const daemon = await open("persist-transaction", e);
  await daemon.start();
  const before = daemon.workspace;
  const beforeLive = await daemon.liveAgents();
  const p = await paths("persist-transaction", e);
  await rm(p.backup, { recursive: true, force: true });
  await mkdir(p.backup);

  await expect(
    daemon.runWorkspaceCommand(command("pane.split", { axis: "row" }), before.revision, context),
  ).rejects.toThrow();
  expect(daemon.workspace).toEqual(before);
  expect(await daemon.liveAgents()).toEqual(beforeLive);
  await daemon.stop();
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
      await run(Session.save(state), e);
    }),
  });
  await daemon.start();
  const before = daemon.workspace;
  await expect(
    Promise.race([
      daemon.runWorkspaceCommand(command("pane.split", { axis: "row" }), before.revision, {
        ...context,
        shell: ["sh", "-c", `printf exited > ${marker}`],
      }),
      Bun.sleep(1_000).then(() => {
        throw new Error("compensation deadlocked");
      }),
    ]),
  ).rejects.toThrow("injected candidate failure");
  expect(await Bun.file(marker).text()).toBe("exited");
  expect(daemon.workspace).toEqual(before);
  expect(await daemon.liveAgents()).toHaveLength(1);
  rejectCandidate = false;
  await daemon.stop();
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
      await run(Session.save(state), e);
    }),
  });
  await daemon.start();
  const p = await paths("private-prepare", e);
  const subscriber = await AttachClient.connect({ path: p.attach, client: "subscriber" });
  const beforeLive = await daemon.liveAgents();
  const model = Effect.runPromise(Stream.runHead(subscriber.workspace()));
  const commandRun = daemon.runWorkspaceCommand(
    command("pane.split", { axis: "row" }),
    daemon.workspace.revision,
    {
      ...context,
      shell: ["sh", "-c", "printf private; sleep 30"],
    },
  );
  await saveStarted;
  // Let the private child produce output before acquiring a stream. If the hub
  // leaked it, AttachClient would already have created an unknown-session queue
  // and runHead would consume that stale frame immediately.
  await Bun.sleep(30);
  const terminal = Effect.runPromise(Stream.runHead(subscriber.stream(preparedId)));
  const status = await daemon.handle({ command: "status" });
  expect(status.agents).toEqual([...beforeLive]);
  expect(await daemon.liveAgents()).toEqual(beforeLive);
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
  await daemon.stop();
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
      await run(Session.save(state), e);
    }),
  });
  await daemon.start();
  const revision = daemon.workspace.revision;
  await expect(
    daemon.runWorkspaceCommand(command("pane.split", { axis: "row" }), revision, context),
  ).rejects.toThrow("one-shot candidate failure");
  expect((await daemon.handle({ command: "status" })).ok).toBe(true);
  const recovered = await daemon.runWorkspaceCommand(
    command("pane.split", { axis: "row" }),
    revision,
    context,
  );
  expect(recovered.spaces[0]!.windows[0]!.agents).toHaveLength(2);
  await daemon.stop();
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
      await run(Session.save(state), e);
    }),
  });
  await daemon.start();
  await expect(
    daemon.runWorkspaceCommand(
      command("pane.split", { axis: "row" }),
      daemon.workspace.revision,
      context,
    ),
  ).rejects.toThrow("injected candidate failure");
  rejectCandidate = false;
  await daemon.close();

  const reopened = await open("no-rollback", e);
  const agents = reopened.state.spaces.flatMap((space) =>
    space.windows.flatMap((window) => window.agents),
  );
  expect(agents).toHaveLength(1);
  await reopened.stop();
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
      await run(Session.save(state), e);
    }),
  });
  await daemon.start();
  const p = await paths("attach-write-race", e);
  const attaching = AttachClient.connect({ path: p.attach, client: "race" });
  await started;
  let renamed = false;
  const rename = daemon
    .runWorkspaceCommand(
      command("space.rename", { name: "winner" }),
      daemon.workspace.revision,
      context,
    )
    .then(() => {
      renamed = true;
    });
  await Bun.sleep(20);
  expect(renamed).toBe(false);
  releaseAttach();
  const client = await attaching;
  await rename;
  const saved = await run(Session.load("attach-write-race"), e);
  expect(saved?.attached).toBe(true);
  expect(saved?.spaces[0]?.name).toBe("winner");
  blockAttach = false;
  blockDetach = true;
  client.close();
  await detaching;
  const secondRename = daemon.runWorkspaceCommand(
    command("space.rename", { name: "newest" }),
    daemon.workspace.revision,
    context,
  );
  releaseDetach();
  await secondRename;
  const detached = await run(Session.load("attach-write-race"), e);
  expect(detached?.attached).toBe(false);
  expect(detached?.spaces[0]?.name).toBe("newest");
  blockDetach = false;
  await daemon.stop();
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
      await run(Session.save(state), e);
    }),
  });
  await daemon.start();
  armed = true;
  const agent = daemon.workspace.spaces[0]!.windows[0]!.agents[0]!.id;
  await daemon.runWorkspaceCommand(
    command("agent.kill", { agent }),
    daemon.workspace.revision,
    context,
  );
  expect(failed).toBe(true);
  expect(daemon.workspace.spaces).toHaveLength(0);
  expect((await daemon.handle({ command: "status" })).ok).toBe(true);
  await daemon.stop();
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
      return Session.save(state).pipe(Effect.provideService(SessionEnv, e));
    },
  });
  await daemon.start();
  const marker = join(e.HOME!, "held-destructive-pid");
  await daemon.spawnAgent({
    id: "held-destructive",
    cmd: ["sh", "-c", `printf '%s' $$ > ${marker}; sleep 30`],
    cols: 80,
    rows: 24,
  });
  const heldPid = await waitForPid(marker);
  armed = true;
  const agent = daemon.workspace.spaces[0]!.windows[0]!.agents[0]!.id;
  const mutation = daemon.runWorkspaceCommand(
    command("agent.kill", { agent }),
    daemon.workspace.revision,
    context,
  );
  void mutation.catch(() => {});
  await saveStarted;
  const started = Date.now();
  await Promise.race([
    daemon.stop(),
    Bun.sleep(1_500).then(() => {
      throw new Error("stop did not interrupt destructive persistence");
    }),
  ]);
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(cancelled).toBe(true);
  await expect(mutation).rejects.toThrow();
  expect(await daemon.liveAgents()).toEqual([]);
  expect(await run(Session.load("kill-save-cancel"), e)).toBeNull();
  await expectProcessGone(heldPid);
});

test("the first heartbeat waits one interval after the startup lease write", async () => {
  const e = await env();
  const daemon = await open("heartbeat-first-fire", e);
  await daemon.start();
  const initial = await run(Session.readLease("heartbeat-first-fire"), e);
  expect(initial).not.toBeNull();

  await Bun.sleep(700);
  expect((await run(Session.readLease("heartbeat-first-fire"), e))?.heartbeatAt).toBe(
    initial!.heartbeatAt,
  );

  const firstBeatBy = Date.now() + 1_000;
  let heartbeatAt = initial!.heartbeatAt;
  while (heartbeatAt === initial!.heartbeatAt && Date.now() < firstBeatBy) {
    await Bun.sleep(10);
    heartbeatAt = (await run(Session.readLease("heartbeat-first-fire"), e))!.heartbeatAt;
  }
  expect(heartbeatAt).toBeGreaterThan(initial!.heartbeatAt);
  await daemon.close();
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
      await run(Session.save(state), e);
    }),
  });
  await daemon.start();
  const initial = await run(Session.readLease("heartbeat-attach-race"), e);
  const p = await paths("heartbeat-attach-race", e);
  const connecting = AttachClient.connect({ path: p.attach, client: "lease-race" });
  await started;

  // The first scheduled beat is now queued behind the blocked attachment.
  await Bun.sleep(1_100);
  releaseAttach();
  const client = await connecting;
  const heartbeatBy = Date.now() + 1_000;
  let lease = await run(Session.readLease("heartbeat-attach-race"), e);
  while (lease?.heartbeatAt === initial?.heartbeatAt && Date.now() < heartbeatBy) {
    await Bun.sleep(10);
    lease = await run(Session.readLease("heartbeat-attach-race"), e);
  }
  expect(lease?.attachments).toEqual([expect.objectContaining({ client: "lease-race" })]);

  blockAttach = false;
  client.close();
  await daemon.stop();
});

test("heartbeat failure is visible and the heartbeat stops with the daemon scope", async () => {
  const e = await env();
  const daemon = await open("heartbeat-scope", e);
  await daemon.start();
  const p = await paths("heartbeat-scope", e);
  await rm(p.lease, { force: true });
  await mkdir(p.lease);

  const failedBy = Date.now() + 3_500;
  let status = await daemon.handle({ command: "status" });
  while (status.ok && Date.now() < failedBy) {
    await Bun.sleep(10);
    status = await daemon.handle({ command: "status" });
  }
  expect(status.ok).toBe(false);
  expect(status.error).toContain("lease heartbeat failed");

  await rm(p.lease, { recursive: true, force: true });
  const recoveredBy = Date.now() + 3_500;
  while (!(await daemon.handle({ command: "status" })).ok && Date.now() < recoveredBy)
    await Bun.sleep(10);
  expect((await daemon.handle({ command: "status" })).ok).toBe(true);

  await daemon.close();
  await daemon.stopped;
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
        : Session.save(state).pipe(Effect.provideService(SessionEnv, e)),
  });
  await daemon.start();
  armed = true;

  const started = Date.now();
  await expect(daemon.close()).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(cancelled).toBe(true);
  await daemon.stopped;

  const replacement = await open("bounded-final-save", e);
  await replacement.stop();
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
      await run(Session.save(state), e);
    }),
  });
  await daemon.start();
  await daemon.runWorkspaceCommand(
    command("pane.split", { axis: "row" }),
    daemon.workspace.revision,
    {
      ...context,
      shell: ["sh", "-c", "exit 7"],
    },
  );
  const deadline = Date.now() + 2_000;
  while (
    !daemon.workspace.spaces[0]!.windows[0]!.agents.some((agent) => agent.exited) &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10);
  }
  expect(failed).toBe(true);
  expect(
    daemon.workspace.spaces[0]!.windows[0]!.agents.some(
      (agent) => agent.exited && agent.exitCode === 7,
    ),
  ).toBe(true);
  expect((await daemon.handle({ command: "status" })).ok).toBe(true);
  await daemon.stop();
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
      await run(Session.save(state), e);
    }),
  });
  await daemon.start();
  await daemon.runWorkspaceCommand(
    command("pane.split", { axis: "row" }),
    daemon.workspace.revision,
    {
      ...context,
      shell: ["sh", "-c", "exit 0"],
    },
  );
  const deadline = Date.now() + 2_000;
  let status = await daemon.handle({ command: "status" });
  while (!status.error?.includes("disk offline") && Date.now() < deadline) {
    await Bun.sleep(10);
    status = await daemon.handle({ command: "status" });
  }
  expect(status.ok).toBe(false);
  expect(status.error).toContain("disk offline");
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
  expect((await daemon.handle({ command: "status" })).ok).toBe(false);
  unavailable = false;
  const client = await connecting;
  const recovered = Date.now() + 2_000;
  while (!(await daemon.handle({ command: "status" })).ok && Date.now() < recovered)
    await Bun.sleep(10);
  expect((await daemon.handle({ command: "status" })).ok).toBe(true);
  client.close();
  await daemon.stop();
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
      return Session.save(state).pipe(Effect.provideService(SessionEnv, e));
    },
  });
  await daemon.start();
  const marker = join(e.HOME!, "held-natural-pid");
  await daemon.spawnAgent({
    id: "held-natural",
    cmd: ["sh", "-c", `printf '%s' $$ > ${marker}; sleep 30`],
    cols: 80,
    rows: 24,
  });
  const heldPid = await waitForPid(marker);
  armed = true;
  await daemon.runWorkspaceCommand(
    command("pane.split", { axis: "row" }),
    daemon.workspace.revision,
    {
      ...context,
      shell: ["sh", "-c", "exit 0"],
    },
  );
  await saveStarted;
  const started = Date.now();
  await Promise.race([
    daemon.close(),
    Bun.sleep(1_500).then(() => {
      throw new Error("close did not interrupt natural-exit persistence");
    }),
  ]);
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(cancelled).toBe(true);
  expect(await daemon.liveAgents()).toEqual([]);
  await expectProcessGone(heldPid);
});

test("a failed destructive action leaves durable state untouched", async () => {
  const e = await env();
  const daemon = await open("kill-transaction", e);
  await daemon.start();
  const before = daemon.workspace;
  const agent = before.spaces[0]!.windows[0]!.agents[0]!.id;
  const kill = daemon.killAgent.bind(daemon);
  (daemon as any).killAgent = async () => {
    throw new Error("injected kill failure");
  };
  await expect(
    daemon.runWorkspaceCommand(command("agent.kill", { agent }), before.revision, context),
  ).rejects.toThrow("injected kill failure");
  expect(daemon.workspace).toEqual(before);
  expect(
    (await run(Session.load("kill-transaction"), e))?.spaces[0]?.windows[0]?.agents[0]?.id,
  ).toBe(agent);
  (daemon as any).killAgent = kill;
  await daemon.stop();
});

test("restore spawn failures are persisted before the daemon accepts clients", async () => {
  const e = await env();
  const layout = JSON.stringify({
    version: 1,
    root: { type: "pane", id: "pane-restore", agent: "agent-restore", weight: 1 },
    focus: "pane-restore",
  });
  await run(
    Session.save({
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
  const daemon = await open("restore-failure", e);
  const spawn = daemon.spawnAgent.bind(daemon);
  (daemon as any).spawnAgent = async (spec: { id: string }) => {
    if (spec.id === "agent-restore") throw new Error("injected restore spawn failure");
    return spawn(spec as any);
  };
  await daemon.start();
  const saved = await run(Session.load("restore-failure"), e);
  expect(JSON.stringify(saved)).not.toContain("agent-restore");
  await daemon.stop();
});

test("a blocked daemon write does not starve timers, RPC, or shutdown", async () => {
  const e = await env();
  const daemon = await open("responsive", e);
  await daemon.start();
  try {
    const pty = await daemon.spawnAgent({
      id: "blocked",
      cmd: ["sh", "-c", "sleep 30"],
      cols: 80,
      rows: 24,
    });
    const write = Effect.runPromise(pty.write("x".repeat(16 * 1024 * 1024)));
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 25);
    const response = await Promise.race([
      run(daemonRequest("responsive", { command: "ping" }), e),
      Bun.sleep(1000).then(() => {
        throw new Error("RPC deadline exceeded");
      }),
    ]);
    expect(response.ok).toBe(true);
    await Bun.sleep(40);
    expect(timerRan).toBe(true);
    await daemon.killAgent("blocked");
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
      daemon.stop(),
      Bun.sleep(1000).then(() => {
        throw new Error("daemon stop deadline exceeded");
      }),
    ]);
  }
});

test("daemon shutdown is bounded when session children trap termination signals", async () => {
  const e = await env();
  const daemon = await open("trapped-shutdown", e);
  await daemon.start();
  const marker = join(e.HOME!, "children");
  await daemon.spawnAgent({
    id: "trapped",
    cmd: [
      "bash",
      "-c",
      `trap '' HUP TERM; printf '%s\\n' "$BASHPID" > ${marker}; (trap '' HUP TERM; printf '%s\\n' "$BASHPID" >> ${marker}; sleep 30) & wait`,
    ],
    cols: 80,
    rows: 24,
  });
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
    daemon.stop(),
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
