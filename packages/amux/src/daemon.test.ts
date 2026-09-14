/** @effect-diagnostics *:skip-file -- a real OS boundary (sockets, subprocess) this suite deliberately
 * drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import {
  makeDaemonService,
  DaemonError,
  type SessionDaemonService,
} from "./daemon.ts";
import { SessionStore, sessionPaths } from "./session.ts";
import { command } from "./commands.ts";
import { AttachClient } from "./attach.ts";
import { waitFor } from "./test-wait.ts";
import type { PaneContent } from "./layout.ts";
import { testEffect } from "./test-effect.ts";
import { registerCleanup, tempDir } from "./test-tmp.ts";
import { ctl, open, run } from "./test-daemon.ts";

registerCleanup();

// A plugin fixture placed alongside this test file rather than under the OS
// tmpdir (see below) — outside tempDir's reach, so it keeps its own cleanup.
const repoDirs: string[] = [];
afterEach(async () => {
  for (const dir of repoDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function env() {
  const home = tempDir("daemon");
  return { HOME: home, XDG_STATE_HOME: join(home, "state") };
}

const paths = (id: string, e: NodeJS.ProcessEnv) => run(sessionPaths(id), e);
const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

const componentState = (
  id: string,
  provider: string,
  opts?: { readonly firstMessage?: { readonly _tag: string; readonly text: string } },
) => {
  const session = {
    id: "component-session",
    name: "component",
    declaredAgent: provider,
    provider,
    kind: "component" as const,
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null as null,
  };
  if (opts?.firstMessage !== undefined) Object.assign(session, { firstMessage: opts.firstMessage });
  return {
    version: 1 as const,
    id,
    createdAt: 1,
    updatedAt: 1,
    attached: false,
    activeSpace: "space-component",
    spaces: [
      {
        id: "space-component",
        name: "component",
        dir: "/tmp",
        activeWindow: 1,
        windows: [
          {
            number: 1,
            name: null,
            layout: JSON.stringify({
              version: 1,
              root: {
                type: "pane",
                id: "pane-component",
                content: {
                  kind: "plugin",
                  type: provider,
                  descriptor: {},
                  session: "component-session",
                },
                weight: 1,
              },
              focus: "pane-component",
            }),
            sessions: [session],
          },
        ],
      },
    ],
  };
};

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

const status = (d: SessionDaemonService, e: NodeJS.ProcessEnv) =>
  ctl(d.id, e, (control) => control.Status());

/** The daemon reports itself healthy: no heartbeat or durability complaint. */
const healthy = async (d: SessionDaemonService, e: NodeJS.ProcessEnv) =>
  (await status(d, e)).degraded === undefined;

const saveEffect = (save: (state: any, signal: AbortSignal) => Promise<void>) => (state: any) =>
  Effect.tryPromise({
    try: (signal) => save(state, signal),
    catch: (error) =>
      new DaemonError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });

test("a permanently empty lock is recovered and its lock file is released", async () => {
  const e = await env();
  const p = await run(sessionPaths("stale-empty"), e);
  await mkdir(p.root, { recursive: true });
  await writeFile(p.lock, "");

  // The lock is empty and nobody will ever write a PID.
  // The explicit timeout catches an unbounded wait; it does not measure the
  // 500ms protocol bound, which can be extended by scheduler latency.
  const daemon = await run(makeDaemonService("stale-empty", {}), e);

  expect(st(daemon).id).toBe("stale-empty");
  await C(daemon);
  await expect(Bun.file(p.lock).exists()).resolves.toBe(false);
}, 5_000);

test("an empty lock written with a live PID during the wait window is not stolen", async () => {
  const e = await env();
  const p = await run(sessionPaths("midwrite"), e);
  await mkdir(p.root, { recursive: true });
  await writeFile(p.lock, "");

  const opening = open("midwrite", e);

  // Give the daemon one poll cycle, then write a live PID into the lock
  // (our own PID — processAlive returns true).
  await Bun.sleep(15);
  await writeFile(p.lock, `${process.pid}\n`);

  await expect(opening).rejects.toThrow(/already being opened/);
});

test("a post-acquisition lease check releases the lock so the next start can proceed", async () => {
  const e = await env();
  const p = await run(sessionPaths("released"), e);
  await mkdir(p.root, { recursive: true });
  await writeFile(
    p.state,
    JSON.stringify({
      version: 1,
      id: "released",
      createdAt: 1,
      updatedAt: 1,
      attached: false,
      spaces: [],
    }),
  );
  // Write a lease with our own PID — the daemon will acquire the lock (wx
  // succeeds because no lock exists) but then the lease check must fail
  // because processAlive(process.pid) returns true.
  await run(
    Effect.flatMap(SessionStore, (store) =>
      store.writeLease({
        version: 1,
        session: "released",
        pid: process.pid,
        socket: p.socket,
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    ),
    e,
  );

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
  await writeFile(
    p.state,
    JSON.stringify({
      version: 1,
      id: "donotdelete",
      createdAt: 1,
      updatedAt: 1,
      attached: false,
      spaces: [],
    }),
  );

  await expect(run(makeDaemonService("donotdelete", {}), e)).rejects.toThrow(
    /already being opened/,
  );

  // The holder's lock file must still exist and be unmodified.
  await expect(Bun.file(p.lock).exists()).resolves.toBe(true);
  expect(await readFile(p.lock, "utf8")).toBe(`${process.pid}\n`);
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

testEffect("last pane removal closes the daemon so the next attach starts fresh", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const d = yield* Effect.promise(() => open("empty", e));
    yield* Effect.promise(() =>
      rwc(d)(command("space.close", { space: ws(d).spaces[0]!.id }), ws(d).revision, context),
    );
    yield* Effect.promise(() =>
      waitFor(
        async () =>
          (await run(
            Effect.flatMap(SessionStore, (store) => store.readLease("empty")),
            e,
          )) === null,
        "the daemon to release its lease",
      ),
    );
    expect(
      yield* Effect.promise(() =>
        run(
          Effect.flatMap(SessionStore, (store) => store.readLease("empty")),
          e,
        ),
      ),
    ).toBeNull();
    const next = yield* Effect.promise(() => open("empty", e));
    const nextWorkspace = yield* next.getWorkspace;
    expect(nextWorkspace.spaces).toHaveLength(1);
    expect(nextWorkspace.spaces[0]!.windows[0]!.sessions[0]!.exited).toBe(false);
    yield* Effect.promise(() => C(next));
  }),
);

test("stopping waits for an in-flight workspace mutation before removing metadata", async () => {
  const e = await env();
  const d = await open("stop-save-race", e);
  const save = rwc(d)(command("space.rename", { name: "p" }), ws(d).revision, context);
  const stop = S(d);
  await Promise.all([save, stop]);
  expect(
    await run(
      Effect.flatMap(SessionStore, (store) => store.load("stop-save-race")),
      e,
    ),
  ).toBeNull();
});

testEffect("the control plane exposes no unrevisioned spawn or kill procedure", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const d = yield* Effect.promise(() => open("no-bypass", e));
    const before = yield* d.liveSessions;
    // The group is the whole surface: anything outside it is refused by the
    // server before a handler exists to run it.
    const rejected = yield* Effect.promise(() =>
      ctl(d.id, e, (c) => (c as any).Spawn({})).then(
        () => false,
        () => true,
      ),
    );
    expect(rejected).toBe(true);
    expect(yield* d.liveSessions).toEqual(before);
    yield* Effect.promise(() => S(d));
  }),
);

testEffect("a persistence failure compensates a spawned PTY and installs no generation", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const d = yield* Effect.promise(() => open("persist-transaction", e));
    const before = ws(d);
    const beforeLive = yield* d.liveSessions;
    const p = yield* Effect.promise(() => paths("persist-transaction", e));
    yield* Effect.promise(() => rm(p.backup, { recursive: true, force: true }));
    yield* Effect.promise(() => mkdir(p.backup));

    const rejected = yield* Effect.promise(() =>
      rwc(d)(command("pane.split", { axis: "row" }), before.revision, context).then(
        () => false,
        () => true,
      ),
    );
    expect(rejected).toBe(true);
    expect(ws(d)).toEqual(before);
    expect(yield* d.liveSessions).toEqual(beforeLive);
    yield* Effect.promise(() => S(d));
  }),
);

testEffect("a fast prepared exit cannot deadlock failed-write compensation", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const marker = join(e.HOME!, "fast-exited");
    let rejectCandidate = true;
    const daemon = yield* Effect.promise(() =>
      open("fast-compensation", e, {
        saveState: saveEffect(async (state: any) => {
          const agents = state.spaces.flatMap((space: any) =>
            space.windows.flatMap((window: any) => window.sessions),
          );
          if (rejectCandidate && agents.length > 1) {
            await waitFor(
              () => Bun.file(marker).exists(),
              "the fast-exiting child to write its marker",
              1_000,
            );
            // Brief yield so the child's natural exit can race the failed write.
            await Bun.sleep(50);
            throw new Error("injected candidate failure");
          }
          await run(
            Effect.flatMap(SessionStore, (store) => store.save(state)),
            e,
          );
        }),
      }),
    );
    // started by startDaemon;
    const before = ws(daemon);
    const failure = yield* Effect.promise(() =>
      Promise.race([
        rwc(daemon)(command("pane.split", { axis: "row" }), before.revision, {
          ...context,
          shell: ["sh", "-c", `printf exited > ${marker}`],
        }),
        Bun.sleep(1_000).then(() => {
          throw new Error("compensation deadlocked");
        }),
      ]).then(
        () => null,
        (error) => error,
      ),
    );
    expect(String(failure)).toContain("injected candidate failure");
    expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("exited");
    expect(ws(daemon)).toEqual(before);
    expect(yield* daemon.liveSessions).toHaveLength(1);
    rejectCandidate = false;
    yield* Effect.promise(() => S(daemon));
  }),
);

testEffect(
  "a prepared session is absent from status and subscribers until its model is durable",
  () =>
    Effect.gen(function* () {
      const e = yield* Effect.promise(() => env());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let saving!: () => void;
      const saveStarted = new Promise<void>((resolve) => {
        saving = resolve;
      });
      let preparedId = "";
      const daemon = yield* Effect.promise(() =>
        open("private-prepare", e, {
          saveState: saveEffect(async (state: any) => {
            const agents = state.spaces.flatMap((space: any) =>
              space.windows.flatMap((window: any) => window.sessions),
            );
            if (agents.length > 1) {
              preparedId = agents.at(-1).id;
              saving();
              await gate;
            }
            await run(
              Effect.flatMap(SessionStore, (store) => store.save(state)),
              e,
            );
          }),
        }),
      );
      // started by startDaemon;
      const p = yield* Effect.promise(() => paths("private-prepare", e));
      const subscriber = yield* Effect.promise(() =>
        AttachClient.connect({
          path: p.attach,
          client: "subscriber",
        }),
      );
      const beforeLive = yield* daemon.liveSessions;
      const model = yield* Effect.forkChild(Stream.runHead(subscriber.workspace));
      const commandRun = rwc(daemon)(command("pane.split", { axis: "row" }), ws(daemon).revision, {
        ...context,
        shell: ["sh", "-c", "printf private; sleep 30"],
      });
      yield* Effect.promise(() => saveStarted);
      const terminal = yield* Effect.forkChild(Stream.runHead(subscriber.stream(preparedId)));
      const live = yield* Effect.promise(() => status(daemon, e));
      expect(live.agents).toEqual([...beforeLive]);
      expect(yield* daemon.liveSessions).toEqual(beforeLive);
      // pollUnsafe undefined ⇒ the subscriber has not received a leaked frame yet.
      expect(model.pollUnsafe()).toBeUndefined();
      expect(terminal.pollUnsafe()).toBeUndefined();

      release();
      yield* Effect.promise(() => commandRun);
      expect((yield* Fiber.join(model))._tag).toBe("Some");
      expect((yield* Fiber.join(terminal))._tag).toBe("Some");
      subscriber.close();
      yield* Effect.promise(() => S(daemon));
    }),
);

test("a one-shot reversible write failure does not poison the next command", async () => {
  const e = await env();
  let fail = true;
  const daemon = await open("candidate-recovery", e, {
    saveState: saveEffect(async (state: any) => {
      const agents = state.spaces.flatMap((space: any) =>
        space.windows.flatMap((window: any) => window.sessions),
      );
      if (fail && agents.length > 1) {
        fail = false;
        throw new Error("one-shot candidate failure");
      }
      await run(
        Effect.flatMap(SessionStore, (store) => store.save(state)),
        e,
      );
    }),
  });
  // started by startDaemon;
  const revision = ws(daemon).revision;
  await expect(
    rwc(daemon)(command("pane.split", { axis: "row" }), revision, context),
  ).rejects.toThrow("one-shot candidate failure");
  expect(await healthy(daemon, e)).toBe(true);
  const recovered = await rwc(daemon)(command("pane.split", { axis: "row" }), revision, context);
  expect(recovered.snapshot.spaces[0]!.windows[0]!.sessions).toHaveLength(2);
  await S(daemon);
});

test("a rejected candidate never reaches current or backup state", async () => {
  const e = await env();
  let rejectCandidate = true;
  const daemon = await open("no-rollback", e, {
    saveState: saveEffect(async (state: any) => {
      const agents = state.spaces.flatMap((space: any) =>
        space.windows.flatMap((window: any) => window.sessions),
      );
      if (rejectCandidate && agents.length > 1) throw new Error("injected candidate failure");
      await run(
        Effect.flatMap(SessionStore, (store) => store.save(state)),
        e,
      );
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
    space.windows.flatMap((window) => window.sessions),
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
      await run(
        Effect.flatMap(SessionStore, (store) => store.save(state)),
        e,
      );
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
  expect(renamed).toBe(false);
  releaseAttach();
  const client = await attaching;
  await rename;
  const saved = await run(
    Effect.flatMap(SessionStore, (store) => store.load("attach-write-race")),
    e,
  );
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
  const detached = await run(
    Effect.flatMap(SessionStore, (store) => store.load("attach-write-race")),
    e,
  );
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
      await run(
        Effect.flatMap(SessionStore, (store) => store.save(state)),
        e,
      );
    }),
  });
  // started by startDaemon;
  armed = true;
  const agent = ws(daemon).spaces[0]!.windows[0]!.sessions[0]!.id;
  await rwc(daemon)(command("session.kill", { target: agent }), ws(daemon).revision, context);
  expect(failed).toBe(true);
  expect(ws(daemon).spaces).toHaveLength(0);
  let lease: unknown;
  await waitFor(async () => {
    lease = await run(
      Effect.flatMap(SessionStore, (store) => store.readLease("kill-write-retry")),
      e,
    );
    return lease === null;
  }, "the retried destructive write to clear the lease");
  expect(lease).toBeNull();
});

test("the first heartbeat waits one interval after the startup lease write", async () => {
  const e = await env();
  const daemon = await open("heartbeat-first-fire", e);
  // started by startDaemon;
  const initial = await run(
    Effect.flatMap(SessionStore, (store) => store.readLease("heartbeat-first-fire")),
    e,
  );
  expect(initial).not.toBeNull();

  const startedAt = Date.now();
  let heartbeatAt = initial!.heartbeatAt;
  await waitFor(
    async () => {
      heartbeatAt = (await run(
        Effect.flatMap(SessionStore, (store) => store.readLease("heartbeat-first-fire")),
        e,
      ))!.heartbeatAt;
      return heartbeatAt !== initial!.heartbeatAt;
    },
    "the first heartbeat",
    3_500,
  );
  // One full Effect.sleep("1 second") after the startup lease write — not an immediate beat.
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
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
      await run(
        Effect.flatMap(SessionStore, (store) => store.save(state)),
        e,
      );
    }),
  });
  // started by startDaemon;
  const initial = await run(
    Effect.flatMap(SessionStore, (store) => store.readLease("heartbeat-attach-race")),
    e,
  );
  const p = await paths("heartbeat-attach-race", e);
  const connecting = AttachClient.connect({
    path: p.attach,
    client: "lease-race",
  });
  await started;

  // Attach save holds the mutation queue; release and the queued beat must publish
  // the committed attachment (not a pre-attach lease snapshot).
  releaseAttach();
  const client = await connecting;
  let lease = await run(
    Effect.flatMap(SessionStore, (store) => store.readLease("heartbeat-attach-race")),
    e,
  );
  await waitFor(
    async () => {
      lease = await run(
        Effect.flatMap(SessionStore, (store) => store.readLease("heartbeat-attach-race")),
        e,
      );
      return (
        lease?.heartbeatAt !== initial?.heartbeatAt &&
        lease?.attachments?.some((a) => a.client === "lease-race") === true
      );
    },
    "the heartbeat behind the attachment",
    2_500,
  );
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

  let report = await status(daemon, e);
  await waitFor(
    async () => {
      report = await status(daemon, e);
      return report.degraded !== undefined;
    },
    "the heartbeat failure to be reported",
    10_000,
  );
  expect(report.degraded).toContain("lease heartbeat failed");

  await rm(p.lease, { recursive: true, force: true });
  await waitFor(() => healthy(daemon, e), "the daemon to recover", 10_000);
  expect(await healthy(daemon, e)).toBe(true);

  await C(daemon);
  await waitFor(
    async () => !(await Bun.file(p.lease).exists()),
    "the lease file to be removed after close",
    5_000,
  );
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
        : Effect.flatMap(SessionStore, (store) => store.save(state)),
  });
  // started by startDaemon;
  armed = true;

  // Boundedness: close must interrupt Effect.never — cancelled is the proof.
  // A tight wall-clock assert flakes under full-suite load (ts-5fdf96).
  await expect(C(daemon)).rejects.toThrow();
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
        .flatMap((window: any) => window.sessions)
        .some((agent: any) => agent.exited);
      if (exited && !failed) {
        failed = true;
        throw new Error("transient disk failure");
      }
      await run(
        Effect.flatMap(SessionStore, (store) => store.save(state)),
        e,
      );
    }),
  });
  // started by startDaemon;
  await rwc(daemon)(command("pane.split", { axis: "row" }), ws(daemon).revision, {
    ...context,
    shell: ["sh", "-c", "exit 7"],
  });
  await waitFor(
    () => ws(daemon).spaces[0]!.windows[0]!.sessions.some((agent) => agent.exited),
    "the spawned shell to exit",
    2_000,
  );
  expect(failed).toBe(true);
  expect(
    ws(daemon).spaces[0]!.windows[0]!.sessions.some(
      (agent) => agent.exited && agent.exitCode === 7,
    ),
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
        .flatMap((window: any) => window.sessions)
        .some((agent: any) => agent.exited);
      if (exited && unavailable) throw new Error("disk offline");
      await run(
        Effect.flatMap(SessionStore, (store) => store.save(state)),
        e,
      );
    }),
  });
  // started by startDaemon;
  await rwc(daemon)(command("pane.split", { axis: "row" }), ws(daemon).revision, {
    ...context,
    shell: ["sh", "-c", "exit 0"],
  });
  let report = await status(daemon, e);
  await waitFor(
    async () => {
      report = await status(daemon, e);
      return report.degraded?.includes("disk offline") === true;
    },
    "the disk failure to be reported",
    2_000,
  );
  expect(report.degraded).toContain("disk offline");
  const p = await paths("exit-unhealthy", e);
  let attached = false;
  const connecting = AttachClient.connect({
    path: p.attach,
    client: "blocked-metadata",
  }).then((client) => {
    attached = true;
    return client;
  });
  await expect(
    Promise.race([
      connecting.then(() => "attached" as const),
      Bun.sleep(200).then(() => "blocked" as const),
    ]),
  ).resolves.toBe("blocked");
  expect(attached).toBe(false);
  expect(await healthy(daemon, e)).toBe(false);
  unavailable = false;
  const client = await connecting;
  await waitFor(() => healthy(daemon, e), "the daemon to recover", 2_000);
  expect(await healthy(daemon, e)).toBe(true);
  client.close();
  await S(daemon);
});

test("a failed destructive action leaves durable state untouched", async () => {
  const e = await env();
  const daemon = await open("kill-transaction", e);
  // started by startDaemon;
  const before = ws(daemon);
  const agent = before.spaces[0]!.windows[0]!.sessions[0]!.id;
  const kill = daemon.killSession.bind(daemon);
  daemon.killSession = () => Effect.fail(new DaemonError({ message: "injected kill failure" }));
  await expect(
    rwc(daemon)(command("session.kill", { target: agent }), before.revision, context),
  ).rejects.toThrow("injected kill failure");
  expect(ws(daemon)).toEqual(before);
  expect(
    (
      await run(
        Effect.flatMap(SessionStore, (store) => store.load("kill-transaction")),
        e,
      )
    )?.spaces[0]?.windows[0]?.sessions[0]?.id,
  ).toBe(agent);
  daemon.killSession = kill;
  await S(daemon);
});

test("restore spawn failures are persisted before the daemon accepts clients", async () => {
  const e = await env();
  const layout = JSON.stringify({
    version: 1,
    root: {
      type: "pane",
      id: "pane-restore",
      content: {
        kind: "plugin",
        type: "missing-harness",
        descriptor: {},
        session: "agent-restore",
      },
      weight: 1,
    },
    focus: "pane-restore",
  });
  await run(
    Effect.flatMap(SessionStore, (store) =>
      store.save({
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
                sessions: [
                  {
                    id: "agent-restore",
                    name: "bad",
                    declaredAgent: "missing-harness",
                    kind: "component",
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
    ),
    e,
  );
  expect(
    (
      await run(
        Effect.flatMap(SessionStore, (store) => store.load("restore-failure")),
        e,
      )
    )?.spaces[0]?.windows[0]?.sessions[0],
  ).toMatchObject({
    id: "agent-restore",
    declaredAgent: "missing-harness",
  });
  const daemon = await open("restore-failure", e);
  const restored = (
    await run(
      Effect.flatMap(SessionStore, (store) => store.load("restore-failure")),
      e,
    )
  )?.spaces[0]?.windows[0]?.sessions[0];
  expect(restored).toMatchObject({
    id: "agent-restore",
    name: "bad",
    declaredAgent: "missing-harness",
    kind: "component",
    cmd: ["bad"],
    exited: false,
    exitCode: null,
  });
  await S(daemon);
});

test("a component provider identity survives session persistence and restore", async () => {
  const e = await env();
  await run(
    Effect.flatMap(SessionStore, (store) => store.save(componentState("identity", "native"))),
    e,
  );

  const first = await open("identity", e);
  const saved = await run(
    Effect.flatMap(SessionStore, (store) => store.load("identity")),
    e,
  );
  const restored = saved!.spaces[0]!.windows[0]!.sessions[0]!;
  expect(restored).toMatchObject({
    declaredAgent: "native",
    provider: "native",
    kind: "component",
  });
  expect(restored.cmd).toBeUndefined();
  await C(first);

  const second = await open("identity", e);
  const afterRestart = (await run(
    Effect.flatMap(SessionStore, (store) => store.load("identity")),
    e,
  ))!.spaces[0]!.windows[0]!.sessions[0]!;
  expect(afterRestart.provider).toBe("native");
  expect(afterRestart.cmd).toBeUndefined();
  await S(second);
});

testEffect("component restore is attach-gated and ResumeAgent does not create a second child", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const marker = join(e.HOME!, "component-spawns");
    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) => store.save(componentState("attach-gated", "test"))),
        e,
      ),
    );
    const daemon = yield* Effect.promise(() => open("attach-gated", e));

    expect(yield* daemon.liveSessions).not.toContain("component-session");

    const argv = ["sh", "-c", `printf 'spawned\\n' >> ${marker}; sleep 30`];
    yield* Effect.promise(() =>
      ctl("attach-gated", e, (control) =>
        control.ResumeAgent({
          session: "component-session",
          provider: "test",
          argv,
        }),
      ),
    );
    yield* Effect.promise(() =>
      waitFor(() => Bun.file(marker).exists(), "the component provider to spawn", 2_000),
    );
    expect((yield* Effect.promise(() => readFile(marker, "utf8"))).trim().split("\n")).toEqual([
      "spawned",
    ]);

    yield* Effect.promise(() =>
      ctl("attach-gated", e, (control) =>
        control.ResumeAgent({
          session: "component-session",
          provider: "test",
          argv,
        }),
      ),
    );
    // Deadline for a spurious second spawn to appear; ResumeAgent must be a no-op.
    yield* Effect.promise(() => Bun.sleep(200));
    expect((yield* Effect.promise(() => readFile(marker, "utf8"))).trim().split("\n")).toHaveLength(
      1,
    );
    const restored = (yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) => store.load("attach-gated")),
        e,
      ),
    ))!.spaces[0]!.windows[0]!.sessions[0]!;
    expect(restored).toMatchObject({
      name: "component",
      exited: false,
    });
    yield* Effect.promise(() => S(daemon));
  }),
);

testEffect("ResumeAgent delivers session.firstMessage once then clears and persists it", () =>
  Effect.gen(function* () {
    const e = yield* Effect.promise(() => env());
    const firstMessage = { _tag: "agent.prompt" as const, text: "deliver me" };
    yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) =>
          store.save(componentState("first-message", "test", { firstMessage })),
        ),
        e,
      ),
    );
    const daemon = yield* Effect.promise(() => open("first-message", e));

    yield* Effect.promise(() =>
      ctl("first-message", e, (control) =>
        control.ResumeAgent({
          session: "component-session",
          provider: "test",
          argv: ["sh", "-c", "sleep 30"],
        }),
      ),
    );

    const after = yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) => store.load("first-message")),
        e,
      ),
    );
    expect(after).not.toBeNull();
    const session = after!.spaces[0]!.windows[0]!.sessions.find(
      (entry) => entry.id === "component-session",
    );
    expect(session?.firstMessage).toBeUndefined();

    // Already live: a second ResumeAgent must not revive a cleared firstMessage.
    yield* Effect.promise(() =>
      ctl("first-message", e, (control) =>
        control.ResumeAgent({
          session: "component-session",
          provider: "test",
          argv: ["sh", "-c", "sleep 30"],
        }),
      ),
    );
    const again = yield* Effect.promise(() =>
      run(
        Effect.flatMap(SessionStore, (store) => store.load("first-message")),
        e,
      ),
    );
    expect(again).not.toBeNull();
    expect(
      again!.spaces[0]!.windows[0]!.sessions.find((entry) => entry.id === "component-session")
        ?.firstMessage,
    ).toBeUndefined();

    yield* Effect.promise(() => S(daemon));
  }),
);

test("an unavailable component provider becomes a tombstone without spawning", async () => {
  const e = await env();
  await run(
    Effect.flatMap(SessionStore, (store) => store.save(componentState("unavailable", "missing"))),
    e,
  );
  let spawned = 0;
  const daemon = await open("unavailable", e, {
    spawnSession: () => {
      spawned++;
      return Effect.die(new Error("unexpected fallback spawn"));
    },
  });

  await ctl("unavailable", e, (control) =>
    control.ResumeAgent({
      session: "component-session",
      provider: "missing",
    }),
  );

  const restored = (await run(
    Effect.flatMap(SessionStore, (store) => store.load("unavailable")),
    e,
  ))!.spaces[0]!.windows[0]!.sessions[0]!;
  expect(spawned).toBe(0);
  expect(restored.exited).toBe(true);
  expect(restored.name).toContain("unavailable: provider 'missing' is unavailable");
  await S(daemon);
});

test("a sessionless plugin pane restores without a backend and without a tombstone", async () => {
  const e = await env();
  const editor: PaneContent = {
    kind: "plugin",
    type: "amux.editor",
    descriptor: { file: "/work/note.txt" },
  };
  await run(
    Effect.flatMap(SessionStore, (store) =>
      store.save({
        version: 1,
        id: "sessionless",
        createdAt: 1,
        updatedAt: 1,
        attached: false,
        activeSpace: "space-sessionless",
        spaces: [
          {
            id: "space-sessionless",
            name: "sessionless",
            dir: "/tmp",
            activeWindow: 1,
            windows: [
              {
                number: 1,
                name: null,
                layout: JSON.stringify({
                  version: 1,
                  root: { type: "pane", id: "pane-editor", content: editor, weight: 1 },
                  focus: "pane-editor",
                }),
                // No session backs the pane, so the daemon has nothing to spawn,
                // resume, or tombstone.
                sessions: [],
              },
            ],
          },
        ],
      }),
    ),
    e,
  );
  let spawned = 0;
  const daemon = await open("sessionless", e, {
    spawnSession: () => {
      spawned++;
      return Effect.die(new Error("a sessionless plugin pane must not spawn a backend"));
    },
  });

  expect(spawned).toBe(0);
  const restored = (await run(
    Effect.flatMap(SessionStore, (store) => store.load("sessionless")),
    e,
  ))!.spaces[0]!.windows[0]!;
  expect(restored.sessions).toHaveLength(0);
  expect(JSON.parse(restored.layout!).root.content).toEqual(editor);
  await S(daemon);
});
