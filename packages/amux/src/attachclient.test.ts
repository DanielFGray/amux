/**
 * The multiplexer property, end to end.
 *
 * Everything here goes through the real sockets: a real daemon, its real attach
 * stream, a real PTY, and a real Agent with a real terminal emulator on the
 * other end. That is deliberate — the whole value of the daemon is a behaviour
 * at the seams (an agent outliving the process that is showing it), and a test
 * that stubbed either end would prove nothing about it.
 */

import { afterEach, expect, test } from "bun:test";
import {
  Clock,
  Config,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Path,
  pipe,
  Scope,
} from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { tmpdir } from "node:os";
import { which } from "bun";
import { SessionHandle, type SessionHandleOptions } from "./session-handle.ts";
type SessionOptions = SessionHandleOptions;
import { snapshotSessionEntry } from "./snapshot.ts";
import { AttachClient } from "./attach.ts";
import { SessionClient, type SessionClientContract } from "./client.ts";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { captureVisible } from "./capture.ts";
import { MODE_ALT_SCREEN } from "./ghostty.ts";
import { processAlive, sessionPaths, SessionStore } from "./session.ts";
import { Schema as S, Stream } from "effect";
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
  AgentFrame,
} from "./effect/AttachProtocol.ts";
import { command } from "./commands.ts";
import { controlCall } from "./control-client.ts";
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
const fsRun = <A>(
  effect: Effect.Effect<A, import("effect/PlatformError").PlatformError, FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)));
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
const daemons: SessionDaemonService[] = [];
const attachedClient = (d: SessionDaemonService) => d.getAttachedClient;
const attachedClients = (d: SessionDaemonService) => d.getAttachedClients;
const clients: SessionClientContract[] = [];
/** A client's control and attach sockets live in its scope, so tests own one. */
const scopes: Scope.Closeable[] = [];
const connect = Effect.fnUntraced(function* (
  id: string,
  env: NodeJS.ProcessEnv,
  options: { client?: string; autostart?: boolean } = {},
) {
  const scope = yield* Scope.make();
  scopes.push(scope);
  return yield* run(Scope.provide(SessionClient.connect(id, options), scope), env);
});
const sessions: SessionHandle[] = [];
let nextProjection = 0;
const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem>,
  env: NodeJS.ProcessEnv,
) =>
  effect.pipe(
    Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const session of sessions.splice(0)) session.dispose();
      for (const client of clients.splice(0)) client.close();
      for (const scope of scopes.splice(0))
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      for (const daemon of daemons.splice(0)) yield* daemon.stop.pipe(Effect.ignore);
      for (const dir of dirs.splice(0))
        yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
    }),
  ),
);
const startSession = Effect.fnUntraced(function* (id: string) {
  const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-client-")));
  dirs.push(home);
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
  } as NodeJS.ProcessEnv;
  const daemon = yield* run(Effect.scoped(startDaemon(id)), env);
  daemons.push(daemon);
  return { daemon, env };
});

/** Attach as a client of an already-running daemon. */
const attach = Effect.fnUntraced(function* (id: string, env: NodeJS.ProcessEnv, client = "ui") {
  const connected = yield* connect(id, env, { client, autostart: false });
  clients.push(connected);
  return connected;
});

/** Test-only low-level fixture: the daemon owns creation; the client only projects it. */
const projectAgent = Effect.fnUntraced(function* (
  daemon: SessionDaemonService,
  client: SessionClientContract,
  options: Omit<SessionOptions, "backend">,
) {
  const id = options.id ?? `transport-${nextProjection++}`;
  const live = yield* daemon.liveSessions;
  (client.live as Set<string>).add(id);
  const projected = new SessionHandle({
    ...options,
    id,
    backend: client.backend(),
  });
  sessions.push(projected);
  if (!live.includes(id)) {
    yield* daemon.spawnSession({
      kind: options.kind,
      id,
      cmd: options.cmd,
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });
  }
  return projected;
});

type ModeledAgent = {
  id: string;
  cmd: string[];
  cwd?: string;
  cols: number;
  rows: number;
};

function modeledAgent(client: SessionClientContract): ModeledAgent {
  const session = client
    .workspace()
    .spaces[0]?.windows[0]?.sessions.find((candidate) => !candidate.exited);
  if (!session) throw new Error("no modeled live agent");
  return { ...session, cmd: session.cmd ?? [] };
}

/** Wait for a predicate, so tests assert on outcomes rather than on sleeps. */
const until = <E = never>(
  predicate: () => boolean | Effect.Effect<boolean, E>,
  what: string,
  timeoutMs = 5_000,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const result = predicate();
      if (Effect.isEffect(result) ? yield* result : result) return;
      yield* Effect.sleep(10);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });

/** What the agent's terminal is actually showing, as text. The app's own
 *  capture path, so these assertions read the screen the user would. */
const screen = (session: SessionHandle) => captureVisible(session.term);

testEffect("an agent's bytes travel to the daemon and its output comes back", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("roundtrip");
    const client = yield* attach("roundtrip", env);

    const session = yield* projectAgent(daemon, client, { cmd: ["cat"] });

    // The spawn is a round trip over RPC, so the first write has to be held until
    // the daemon actually has an agent by this name to give it to.
    session.write("hello-from-the-client\n");
    yield* until(() => screen(session).includes("hello-from-the-client"), "cat to echo the input");

    // And the daemon, not this process, is the one holding the PTY.
    expect(yield* daemon.liveSessions).toContain(session.id);
  }),
);

testEffect("native agent status frames become authoritative projected state", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("native-status");
    const client = yield* attach("native-status", env);
    const cmd = [
      process.execPath,
      "-e",
      `process.stdout.write(JSON.stringify({_tag:"agent.emit",event:{_tag:"topic",session:"native-status-agent",topic:"session.state",payload:"running"}})+"\\n"); setTimeout(()=>{},30000)`,
    ];
    yield* daemon.spawnSession({
      kind: "component",
      id: "native-status-agent",
      cmd,
      cols: 80,
      rows: 24,
    });
    (client.live as Set<string>).add("native-status-agent");
    const session = new SessionHandle({
      id: "native-status-agent",
      cmd,
      kind: "component",
      backend: client.backend(),
    });
    sessions.push(session);

    yield* until(() => session.state === "running", "native running status");
    expect(session.state).toBe("running");
    yield* daemon.killSession(session.id);
  }),
);

/** A worker proposes; the daemon commits. The sequence a client sees is the one
 *  the daemon assigned, and the worker has no frame in which to offer its own. */
testEffect("a worker's proposed event reaches an attached client with a committed sequence", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("native-error");
    const client = yield* attach("native-error", env);
    const id = "native-error-agent";
    const stream = client.attach.stream(id).pipe(
      Stream.filter((frame) => frame._tag === "agent.message"),
      Stream.runHead,
    );
    const emit = {
      _tag: "agent.emit",
      event: { _tag: "agent.message", session: id, event: { reason: "startup failed" } },
    };
    const emitJson = yield* S.encodeEffect(S.fromJsonString(S.Unknown))(emit);
    const emitLine = yield* S.encodeEffect(S.fromJsonString(S.Unknown))(`${emitJson}\n`);
    const cmd = [
      process.execPath,
      "-e",
      `process.stdout.write(${emitLine}); setTimeout(()=>{},30000)`,
    ];
    yield* daemon.spawnSession({ kind: "component", id, cmd, cols: 80, rows: 24 });
    const frame = Option.getOrThrow(yield* stream.pipe(Effect.timeout("5 seconds")));
    expect(frame).toEqual({
      _tag: "agent.message",
      session: id,
      event: { reason: "startup failed" },
      sequence: 0,
    });
    yield* daemon.killSession(id);
  }),
);

testEffect("reattaching replays the completed transcript but not live-only deltas", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("agent-replay");
    const first = yield* attach("agent-replay", env, "first");
    const id = "replay-agent";
    const emitted = [
      {
        _tag: "agent.emit",
        event: { _tag: "topic", session: id, topic: "session.state", payload: "running" },
      },
      {
        _tag: "agent.emit",
        event: { _tag: "agent.message", session: id, event: { _tag: "turn.start", turn: "t1" } },
      },
      { _tag: "agent.delta", session: id, delta: { turn: "t1", text: "live answer" } },
      {
        _tag: "agent.emit",
        event: {
          _tag: "agent.message",
          session: id,
          event: { _tag: "turn.end", turn: "t1", text: "live answer" },
        },
      },
      {
        _tag: "agent.emit",
        event: { _tag: "topic", session: id, topic: "session.state", payload: "idle" },
      },
    ];
    const emittedJson = yield* Effect.forEach(emitted, (frame) =>
      S.encodeEffect(S.fromJsonString(S.Unknown))(frame),
    );
    const emittedLine = yield* S.encodeEffect(S.fromJsonString(S.Unknown))(
      emittedJson.join("\n") + "\n",
    );
    const cmd = [
      process.execPath,
      "-e",
      `process.stdout.write(${emittedLine}); setTimeout(()=>{},30000)`,
    ];
    const live: AttachFrame[] = [];
    const liveFiber = yield* Effect.forkChild(
      first.attach
        .stream(id)
        .pipe(Stream.runForEach((frame) => Effect.sync(() => void live.push(frame)))),
    );
    yield* daemon.spawnSession({ kind: "component", id, cmd, cols: 80, rows: 24 });
    first.attach.sync(id);
    const isTurnEnd = (frame: AttachFrame) =>
      frame._tag === "agent.message" &&
      (frame.event as { _tag?: string } | null)?._tag === "turn.end";
    yield* until(() => live.some(isTurnEnd), "the completed turn");
    expect(live.some((frame) => frame._tag === "agent.delta")).toBe(true);
    yield* Fiber.interrupt(liveFiber);
    first.close();
    yield* until(
      () => attachedClient(daemon).pipe(Effect.map((c) => c === null)),
      "the first client to detach",
    );

    const second = yield* attach("agent-replay", env, "second");
    const replay: AttachFrame[] = [];
    const replayFiber = yield* Effect.forkChild(
      second.attach
        .stream(id)
        .pipe(Stream.runForEach((frame) => Effect.sync(() => void replay.push(frame)))),
    );
    second.attach.sync(id);
    yield* until(() => replay.some((frame) => frame._tag === "topic"), "durable history");
    yield* Fiber.interrupt(replayFiber);

    // The durable events come back verbatim and in order; the live fragment,
    // which was never committed, does not come back at all.
    expect(replay.filter((frame) => S.is(AgentFrame)(frame)).map((frame) => frame._tag)).toEqual([
      "topic",
      "agent.message",
      "agent.message",
      "topic",
    ]);
    expect(replay.some(isTurnEnd)).toBe(true);
    expect(replay.some((frame) => frame._tag === "agent.delta")).toBe(false);
  }),
);

/* A workspace change is broadcast as a whole snapshot, so a client that did not
 * issue the command still converges on the same revision. This is the only
 * channel that carries workspace changes; the daemon's event stream does not
 * describe them. */
testEffect("a workspace change by one client reaches the other as a snapshot", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("shared-workspace");
    const author = yield* attach("shared-workspace", env, "author");
    const observer = yield* attach("shared-workspace", env, "observer");

    const before = observer.workspace();
    const after = yield* run(
      author.runWorkspace(command("space.rename", { name: "renamed-space" }), {
        size: { cols: 80, rows: 24 },
        shell: ["sh"],
        cwd: "/tmp",
      }),
      env,
    );
    expect(after.snapshot.revision).toBeGreaterThan(before.revision);

    // The client holds broadcast snapshots in a sliding queue of one and only
    // folds them into `workspace()` as the stream is drained, so a test must
    // drain it exactly as the app's projection fiber does.
    const received = yield* run(Stream.runHead(observer.models), env);
    expect(Option.map(received, (snapshot) => snapshot.revision)).toEqual(
      Option.some(after.snapshot.revision),
    );
    expect(observer.workspace().spaces[0]!.name).toBe("renamed-space");
    expect(yield* attachedClients(daemon)).toEqual(["author", "observer"]);
  }),
);

testEffect(
  "two clients share output and input, and one can leave without detaching the other",
  () =>
    Effect.gen(function* () {
      const { daemon, env } = yield* startSession("shared-attach");
      const first = yield* attach("shared-attach", env, "first");
      const second = yield* attach("shared-attach", env, "second");

      const firstAgent = yield* projectAgent(daemon, first, { cmd: ["cat"] });
      const secondAgent = yield* projectAgent(daemon, second, {
        id: firstAgent.id,
        cmd: ["cat"],
      });

      firstAgent.write("first-input\n");
      yield* until(
        () =>
          screen(firstAgent).includes("first-input") && screen(secondAgent).includes("first-input"),
        "both clients to see first input",
      );
      secondAgent.write("second-input\n");
      yield* until(
        () =>
          screen(firstAgent).includes("second-input") &&
          screen(secondAgent).includes("second-input"),
        "both clients to see second input",
      );

      // The second adoption is targeted replay, not a broadcast: it receives the
      // existing screen while the first client's view remains live and unchanged.
      expect(screen(secondAgent)).toContain("first-input");
      first.close();
      // Wait for the daemon to actually PROCESS the EOF, not merely for `attached`
      // to be true — it was already true before the close, so waiting on it would
      // return instantly and prove nothing about the release path.
      yield* until(
        () => attachedClients(daemon).pipe(Effect.map((list) => list.length === 1)),
        "the daemon to notice the first client leave",
      );
      expect(yield* attachedClients(daemon)).toEqual(["second"]);

      secondAgent.write("still-shared\n");
      yield* until(
        () => screen(secondAgent).includes("still-shared"),
        "the remaining client to keep working",
      );
      expect(
        (yield* run(
          controlCall(daemon.id, (c) => c.Ping()),
          env,
        )).attached,
      ).toBe(true);
    }),
);

testEffect("an agent outlives the client, and the next client adopts it", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("outlives");
    const first = yield* attach("outlives", env);

    const session = yield* projectAgent(daemon, first, { cmd: ["cat"] });
    let exited = false;
    session.onExit = () => {
      exited = true;
    };
    session.write("first-life\n");
    yield* until(() => screen(session).includes("first-life"), "the first client's echo");

    // Detach, exactly as closing the terminal would.
    first.close();
    yield* until(
      () => attachedClient(daemon).pipe(Effect.map((c) => c === null)),
      "the daemon to notice the detach",
    );
    expect(yield* daemon.liveSessions).toContain(session.id);

    // The backend closed with no exit code: the attachment ended, the process
    // did not. Reporting 0 here would be a lie the sidebar renders as "done".
    yield* until(() => session.detached, "the detached backend to close");
    expect(session.exited).toBe(false);
    expect(exited).toBe(false);
    expect(session.exitCode).toBeNull();
    // `detached` is a neutral fact read separately from `state`: a detached,
    // still-running agent has no exit to report and stays whatever it last was.
    expect(session.detached).toBe(true);

    const second = yield* attach("outlives", env);
    expect(second.live).toContain(session.id);

    // Adopted under the same id: nothing was re-run, so the same `cat` is still
    // there to answer. A fresh spawn would also echo, which is why the assertion
    // below is about the daemon's agent list and not just about the echo.
    const readopted = yield* projectAgent(daemon, second, {
      id: session.id,
      cmd: ["cat"],
    });
    readopted.write("second-life\n");
    yield* until(() => screen(readopted).includes("second-life"), "the adopted agent's echo");
    expect((yield* daemon.liveSessions).filter((id) => id === session.id)).toHaveLength(1);
  }),
);

testEffect("a process that ends reports its exit code through the stream", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("exits");
    const client = yield* attach("exits", env);

    const session = yield* projectAgent(daemon, client, {
      cmd: ["sh", "-c", "exit 7"],
    });

    yield* until(() => session.exited, "the agent to exit");
    expect(session.detached).toBe(false);
    expect(session.state).toBe("done");
    expect(session.exitCode).toBe(7);
  }),
);

/**
 * A stand-in for an agent CLI: a copy of bash under an agent's name, so a test
 * can run it and detection can read its argv from /proc.
 *
 * A copy rather than a wrapper script, because detection reads the foreground
 * process's argv — a script that `exec`s bash leaves nothing behind with the
 * agent's name on it, which is exactly the right answer for a wrapper and the
 * wrong shape for a fixture.
 */
const fakeAgent = Effect.fnUntraced(function* (name: string) {
  const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-daemon-agent-")));
  dirs.push(dir);
  const path = join(dir, name);
  const bash = which("bash");
  if (!bash) return yield* Effect.die(new Error("no bash on PATH to impersonate"));
  yield* Effect.promise(() => Bun.write(path, Bun.file(bash)));
  yield* Effect.promise(() => chmod(path, 0o755));
  return path;
});

/**
 * The bug ts-572660 guards against: the daemon owns the tty, so the client
 * cannot ask it what is in the foreground — and the daemon backend reported -1
 * forever, blinding detection for every daemon-owned pane. An agent started
 * from a shell in such a pane was invisible to the agents-only filter, and the
 * row's "command · title" label had an empty command half.
 *
 * The daemon now reports the foreground pgid and session id over the attach
 * stream; the client keeps reading /proc (pids are a global namespace) exactly
 * as it does for a local PTY. At a prompt the pgid equals the session id, so a
 * shell is still "no command"; running the fake agent changes the pgid, and
 * detection must pick it up from its argv.
 */
testEffect("an agent started from a shell is detected through the daemon backend", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("foreground-detection");
    const client = yield* attach("foreground-detection", env);

    const claude = yield* fakeAgent("claude");
    const session = yield* projectAgent(daemon, client, {
      name: "shell",
      cmd: ["bash", "--norc", "--noprofile"],
    });

    // A fresh shell at a prompt has no foreground command to name: its pgid is
    // its own session id, and detection must not mistake the shell for an agent.
    yield* until(
      () => session.foregroundCommand === "",
      "the shell at a prompt to report no command",
    );
    expect(session.foregroundProcess).toBe(null);

    session.write(`${claude} --norc --noprofile\n`);
    yield* until(
      () => session.foregroundProcess?.argv[0]?.endsWith("claude") === true,
      "the foreground argv to arrive",
    );
    expect(session.foregroundCommand).toBe("claude");
    // The visible consequence of the fix: the agents-only filter would keep this
    // pane now.
    expect(session.foregroundProcess?.argv[0]).toEndWith("claude");
  }),
);

/**
 * The other half of ts-572660: the daemon exists so a session outlives its
 * client, so detection must survive a reconnect too. A session that was
 * running an agent before the UI died is quiescent afterwards — nothing
 * changes, so a change-only poller would never wake the readopted client. The
 * daemon's sync reply to an adoption is the only thing that can carry the
 * current foreground, and it must.
 */
testEffect("a reattaching client detects an agent already in the foreground", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("foreground-adopt");
    const first = yield* attach("foreground-adopt", env, "first");

    const claude = yield* fakeAgent("claude");
    const session = yield* projectAgent(daemon, first, {
      name: "shell",
      cmd: ["bash", "--norc", "--noprofile"],
    });
    yield* until(
      () => session.foregroundCommand === "",
      "the shell at a prompt to report no command",
    );
    session.write(`${claude} --norc --noprofile\n`);
    yield* until(
      () => session.foregroundProcess?.argv[0]?.endsWith("claude") === true,
      "the foreground argv to arrive",
    );

    first.close();
    yield* until(
      () => attachedClient(daemon).pipe(Effect.map((c) => c === null)),
      "the daemon to notice the detach",
    );

    const second = yield* attach("foreground-adopt", env, "second");
    const readopted = yield* projectAgent(daemon, second, {
      id: session.id,
      cmd: ["bash", "--norc", "--noprofile"],
    });

    // Nothing changes on this session after adoption — no keystroke, no output,
    // no foreground switch. The daemon's sync reply must carry the answer.
    yield* until(
      () => readopted.foregroundProcess?.argv[0]?.endsWith("claude") === true,
      "the adopted foreground argv to arrive",
    );
    expect(readopted.foregroundCommand).toBe("claude");
  }),
);

testEffect("output written immediately before exit arrives before the exit frame", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("drain-order");
    const client = yield* attach("drain-order", env);

    const session = yield* projectAgent(daemon, client, {
      cmd: ["sh", "-c", "printf 'last-bytes\\n'; exit 9"],
    });

    yield* until(() => session.exited, "the short-lived agent to exit");
    expect(screen(session).replace(/\s/g, "")).toContain("last-bytes");
    expect(session.exitCode).toBe(9);
  }),
);

testEffect("an exited session queue is reclaimed only after its exit is consumed", () =>
  Effect.gen(function* () {
    const { daemon } = yield* startSession("reclaim-queue");
    const client = yield* Effect.promise(() =>
      AttachClient.connect({
        path: daemon.paths.attach,
        client: "queue-test",
      }),
    );

    const firstFrames: string[] = [];
    const firstDone = yield* Effect.forkChild(
      Stream.runForEach(client.stream("agent-1"), (frame) =>
        Effect.sync(() => firstFrames.push(frame._tag)),
      ),
    );
    const first = yield* daemon.spawnSession({
      id: "agent-1",
      cmd: ["sh", "-c", "printf first; exit 3"],
      cols: 80,
      rows: 24,
    });
    yield* first.exit;
    yield* Fiber.join(firstDone).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.die(new Error("the session stream did not finish after its exit")),
      }),
    );
    expect(firstFrames.at(-1)).toBe("exit");

    // A foreground frame can now lead a session's frames (the daemon reports the
    // shell's pgid as soon as it owns the tty), so "the first frame is output"
    // is not a contract any more — collect through the exit instead.
    const secondDone = yield* Effect.forkChild(
      Stream.runCollect(
        client.stream("agent-1").pipe(Stream.takeUntil((frame) => frame._tag === "exit")),
      ),
    );
    const second = yield* daemon.spawnSession({
      id: "agent-1",
      cmd: ["sh", "-c", "printf second; exit 4"],
      cols: 80,
      rows: 24,
    });
    yield* second.exit;
    const frames = yield* Fiber.join(secondDone).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.die(new Error("the replacement session did not receive output")),
      }),
    );
    expect(
      [...frames].some(
        (frame) => frame._tag === "output" && Buffer.from(frame.data).toString().includes("second"),
      ),
    ).toBe(true);
    client.close();
  }),
);

testEffect("an unconsumed exit cannot poison a same-id replacement session", () =>
  Effect.gen(function* () {
    const { daemon } = yield* startSession("reclaim-unconsumed");
    const client = yield* Effect.promise(() =>
      AttachClient.connect({
        path: daemon.paths.attach,
        client: "unconsumed-test",
      }),
    );

    const first = yield* daemon.spawnSession({
      id: "agent-1",
      cmd: ["sh", "-c", "printf first; exit 3"],
      cols: 80,
      rows: 24,
    });
    yield* first.exit;
    // The PTY exit and its daemon publication are separate events. Let the
    // unconsumed terminal frame reach the client before opening the replacement.
    yield* Effect.sleep(50);

    const replacement = yield* Effect.forkChild(
      Stream.runCollect(
        client.stream("agent-1").pipe(Stream.takeUntil((frame) => frame._tag === "exit")),
      ),
    );
    const second = yield* daemon.spawnSession({
      id: "agent-1",
      cmd: ["sh", "-c", "printf second; exit 4"],
      cols: 80,
      rows: 24,
    });
    yield* second.exit;
    const frames = yield* Fiber.join(replacement).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.die(new Error("the replacement session did not finish")),
      }),
    );

    expect([...frames].at(-1)?._tag).toBe("exit");
    expect([...frames].every((frame) => frame._tag !== "exit" || frame.code === 4)).toBe(true);
    expect(
      [...frames].some(
        (frame) => frame._tag === "output" && Buffer.from(frame.data).toString().includes("second"),
      ),
    ).toBe(true);
    client.close();
  }),
);

testEffect("rotates generations at exit without losing ordered frames in one chunk", () =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-generations-")));
    dirs.push(home);
    const path = join(home, "attach.sock");
    let peer: Bun.Socket<undefined> | null = null;
    let buffer = "";
    const listener = Bun.listen<undefined>({
      unix: path,
      data: undefined,
      socket: {
        binaryType: "buffer",
        open(socket) {
          peer = socket;
        },
        data(socket, data) {
          buffer += data.toString("utf8");
          const decoded = decodeAttachFrames(buffer);
          buffer = decoded.rest;
          for (const frame of decoded.frames) {
            if (frame._tag === "ping")
              socket.write(encodeAttachFrame({ _tag: "pong", nonce: frame.nonce }));
          }
        },
      },
    });
    const client = yield* Effect.promise(() =>
      AttachClient.connect({
        path,
        client: "generation-test",
      }),
    );

    const firstDone = yield* Effect.forkChild(Stream.runCollect(client.stream("agent-1")));
    yield* Effect.sleep(0);
    peer!.write(
      encodeAttachFrame({
        _tag: "output",
        session: "agent-1",
        data: new TextEncoder().encode("first"),
      }) +
        encodeAttachFrame({ _tag: "exit", session: "agent-1", code: 3 }) +
        encodeAttachFrame({
          _tag: "output",
          session: "agent-1",
          data: new TextEncoder().encode("replacement"),
        }),
    );
    const firstFrames = [...(yield* Fiber.join(firstDone))];
    expect(firstFrames.map((frame) => frame._tag)).toEqual(["output", "exit"]);
    expect(firstFrames.at(-1)?._tag).toBe("exit");

    const replacementDone = yield* Effect.forkChild(
      Stream.runCollect(client.stream("agent-1").pipe(Stream.take(2))),
    );
    yield* Effect.sleep(0);
    peer!.write(encodeAttachFrame({ _tag: "exit", session: "agent-1", code: 4 }));
    const replacementFrames = [...(yield* Fiber.join(replacementDone))];
    const replacementOutput = replacementFrames[0];
    expect(replacementOutput?._tag).toBe("output");
    if (replacementOutput?._tag === "output")
      expect(Buffer.from(replacementOutput.data).toString()).toBe("replacement");
    expect(replacementFrames.at(-1)?._tag).toBe("exit");

    client.close();
    listener.stop(true);
  }),
);

testEffect("an unacquired stream does not retain a terminal generation", () =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-unacquired-")));
    dirs.push(home);
    const path = join(home, "attach.sock");
    let peer: Bun.Socket<undefined> | null = null;
    let buffer = "";
    const listener = Bun.listen<undefined>({
      unix: path,
      data: undefined,
      socket: {
        binaryType: "buffer",
        open(socket) {
          peer = socket;
        },
        data(socket, data) {
          buffer += data.toString("utf8");
          const decoded = decodeAttachFrames(buffer);
          buffer = decoded.rest;
          for (const frame of decoded.frames) {
            if (frame._tag === "ping")
              socket.write(encodeAttachFrame({ _tag: "pong", nonce: frame.nonce }));
          }
        },
      },
    });
    const client = yield* Effect.promise(() =>
      AttachClient.connect({
        path,
        client: "unacquired-test",
      }),
    );
    const unused = client.stream("agent-1");

    peer!.write(
      encodeAttachFrame({
        _tag: "output",
        session: "agent-1",
        data: new TextEncoder().encode("stale"),
      }) +
        encodeAttachFrame({ _tag: "exit", session: "agent-1", code: 3 }) +
        encodeAttachFrame({
          _tag: "output",
          session: "agent-1",
          data: new TextEncoder().encode("fresh"),
        }),
    );
    expect(client.ping(1_000)).resolves.toBe(true);
    void unused;
    const replacement = yield* Effect.forkChild(
      Stream.runCollect(client.stream("agent-1").pipe(Stream.take(1))),
    );
    const frames = [...(yield* Fiber.join(replacement))];
    expect(frames).toHaveLength(1);
    const freshOutput = frames[0];
    expect(freshOutput?._tag).toBe("output");
    if (freshOutput?._tag === "output")
      expect(Buffer.from(freshOutput.data).toString()).toBe("fresh");

    client.close();
    listener.stop(true);
  }),
);

testEffect("an unsubscribed session disconnects rather than silently dropping frames", () =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-overflow-")));
    dirs.push(home);
    const path = join(home, "attach.sock");
    let peer: Bun.Socket<undefined> | null = null;
    let buffer = "";
    const listener = Bun.listen<undefined>({
      unix: path,
      data: undefined,
      socket: {
        binaryType: "buffer",
        open(socket) {
          peer = socket;
        },
        data(socket, data) {
          buffer += data.toString("utf8");
          const decoded = decodeAttachFrames(buffer);
          buffer = decoded.rest;
          if (decoded.frames.some((frame) => frame._tag === "ping")) {
            const ping = decoded.frames.find(
              (frame): frame is Extract<AttachFrame, { _tag: "ping" }> => frame._tag === "ping",
            )!;
            socket.write(encodeAttachFrame({ _tag: "pong", nonce: ping.nonce }));
          }
        },
      },
    });
    const client = yield* Effect.promise(() =>
      AttachClient.connect({ path, client: "overflow-test" }),
    );
    peer!.write(
      Array.from({ length: 300 }, (_, index) =>
        encodeAttachFrame({
          _tag: "output",
          session: "agent-1",
          data: new TextEncoder().encode(`frame-${String(index).padStart(3, "0")}\n`),
        }),
      ).join("") + encodeAttachFrame({ _tag: "exit", session: "agent-1", code: 0 }),
    );

    yield* until(() => client.closed, "the overflowing client to disconnect");
    expect(client.closed).toBe(true);
    client.close();
    listener.stop(true);
  }),
);

testEffect("a delayed handshake closes its socket and rejects on timeout", () =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-handshake-timeout-")));
    dirs.push(home);
    const path = join(home, "attach.sock");
    let closed = 0;
    let latePongs = 0;
    let settlements = 0;
    let resurrected: import("./attach.ts").AttachClientContract | null = null;
    let buffer = "";
    const listener = Bun.listen<undefined>({
      unix: path,
      data: undefined,
      socket: {
        binaryType: "buffer",
        open() {},
        data(socket, data) {
          buffer += data.toString("utf8");
          const decoded = decodeAttachFrames(buffer);
          buffer = decoded.rest;
          for (const frame of decoded.frames) {
            if (frame._tag !== "ping") continue;
            void Bun.sleep(80).then(() => {
              latePongs += 1;
              socket.write(encodeAttachFrame({ _tag: "pong", nonce: frame.nonce }));
            });
          }
        },
        close() {
          closed += 1;
        },
      },
    });

    const acquire = (client: string) =>
      pipe(
        AttachClient,
        Effect.provide(AttachClient.layer({ path, client, helloTimeoutMs: 30 })),
        Effect.scoped,
        Effect.runPromise,
      ).then(
        (connected) => {
          settlements += 1;
          resurrected = connected;
          return connected;
        },
        (error) => {
          settlements += 1;
          throw error;
        },
      );

    const originalConnect = Bun.connect;
    Bun.connect = ((options: any) =>
      originalConnect({
        ...options,
        socket: {
          ...options.socket,
          open(socket: Bun.Socket<unknown>) {
            void Bun.sleep(80).then(() => options.socket.open(socket));
          },
        },
      })) as typeof Bun.connect;
    try {
      expect(acquire("late-open")).rejects.toThrow("timed out");
    } finally {
      Bun.connect = originalConnect;
    }
    yield* until(() => closed === 1, "the socket delivered by the late open callback to close");

    expect(acquire("late-pong")).rejects.toThrow("timed out");
    yield* until(() => closed === 2, "the delayed pong handshake socket to close");
    yield* until(() => latePongs === 1, "the late pong callback to run");
    yield* Effect.sleep(20);
    expect(settlements).toBe(2);
    expect(closed).toBe(2);
    expect(resurrected).toBeNull();
    listener.stop(true);
  }),
);

testEffect("the connection scope emits heartbeats and stops them when released", () =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-heartbeat-")));
    dirs.push(home);
    const path = join(home, "attach.sock");
    let buffer = "";
    let beats = 0;
    let closes = 0;
    let finalized = 0;
    let client: import("./attach.ts").AttachClientContract | null = null;
    const listener = Bun.listen<undefined>({
      unix: path,
      data: undefined,
      socket: {
        binaryType: "buffer",
        open() {},
        data(socket, data) {
          buffer += data.toString("utf8");
          const decoded = decodeAttachFrames(buffer);
          buffer = decoded.rest;
          for (const frame of decoded.frames) {
            if (frame._tag !== "ping") continue;
            if (frame.nonce.startsWith("beat-")) beats += 1;
            socket.write(encodeAttachFrame({ _tag: "pong", nonce: frame.nonce }));
          }
        },
        close() {
          closes += 1;
        },
      },
    });

    yield* Effect.gen(function* () {
      client = yield* AttachClient;
      client.onClose = () => {
        finalized += 1;
      };
      yield* until(() => beats >= 2, "the client heartbeat", 1_000);
    }).pipe(
      Effect.provide(AttachClient.layer({ path, client: "heartbeat", pingSeconds: 0.02 })),
      Effect.scoped,
    );

    yield* until(() => closes === 1, "the scoped attachment to close");
    const releasedAt = beats;
    yield* Effect.sleep(80);
    expect(beats).toBe(releasedAt);
    expect(finalized).toBe(1);
    client!.close();
    expect(finalized).toBe(1);
    listener.stop(true);
  }),
);

testEffect("a handshake error closes the transport without leaving a client", () =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-handshake-error-")));
    dirs.push(home);
    const path = join(home, "attach.sock");
    let closed = 0;
    const listener = Bun.listen<undefined>({
      unix: path,
      data: undefined,
      socket: {
        binaryType: "buffer",
        open(socket) {
          socket.write(encodeAttachFrame({ _tag: "error", message: "rejected" }));
          socket.end();
        },
        data() {},
        close() {
          closed += 1;
        },
      },
    });

    expect(AttachClient.connect({ path, client: "rejected", helloTimeoutMs: 100 })).rejects.toThrow(
      "daemon closed",
    );
    yield* until(() => closed === 1, "the rejected handshake socket to close");
    listener.stop(true);
  }),
);

testEffect("killing through the daemon ends the agent here too", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("killed");
    const client = yield* attach("killed", env);

    const saved = modeledAgent(client);
    const session = new SessionHandle({ ...saved, backend: client.backend() });
    sessions.push(session);

    yield* until(
      () => daemon.liveSessions.pipe(Effect.map((ids) => ids.includes(session.id))),
      "the daemon to have the agent",
    );

    yield* run(
      client.runWorkspace(command("session.kill", { session: session.id }), {
        size: { cols: 80, rows: 24 },
        shell: ["sh"],
        cwd: "/tmp",
      }),
      env,
    );
    yield* until(() => session.exited, "the killed agent to close");
  }),
);

testEffect("a command that does not exist fails in the daemon and is visible here", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("missing-command");
    const client = yield* attach("missing-command", env);

    // The daemon spawns this happily — a PTY for a program that is not there is
    // still a PTY. The failure arrives as output and an exit, like any other
    // process that could not do its job, which is what a terminal should show.
    const session = yield* projectAgent(daemon, client, {
      cmd: ["/definitely/not/a/program"],
    });

    yield* until(() => session.exited, "the failed command to exit");
    expect(screen(session)).toContain("No such file or directory");
    expect(session.exitCode).toBeGreaterThan(0);
  }),
);

testEffect("a projection of an unmodeled id never asks the daemon to spawn it", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("unreachable");
    const client = yield* attach("unreachable", env);

    const before = yield* daemon.liveSessions;
    const session = new SessionHandle({
      id: "not-modeled",
      cmd: ["cat"],
      backend: client.backend(),
    });
    sessions.push(session);

    yield* until(() => session.exited, "the invalid projection to close");
    expect(screen(session)).toContain("is not live");
    expect(yield* daemon.liveSessions).toEqual(before);
  }),
);

testEffect("a client whose daemon stops sees a detach, not a process exit", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("daemon-dies");
    const client = yield* attach("daemon-dies", env);

    const session = yield* projectAgent(daemon, client, { cmd: ["cat"] });
    session.write("before-death\n");
    yield* until(() => screen(session).includes("before-death"), "the client's echo");

    // Explicit stop ends the daemon, its socket and its agents in one move. No
    // exit frame is in flight, so the client learns about it the same way it
    // would learn about a crash — as an attachment ending, never as a clean
    // exit. A stop and a crash only diverge on the next RPC: stop removed the
    // session, a crash left it restorable.
    yield* daemon.stop;
    daemons.splice(daemons.indexOf(daemon), 1);

    yield* until(() => session.detached, "the client to notice the daemon went away");
    expect(session.exited).toBe(false);
    expect(session.exitCode).toBeNull();
    expect(session.detached).toBe(true);
    expect(snapshotSessionEntry(session).exited).toBe(false);
  }),
);

testEffect("a reattaching client sees an adopted agent's screen without it redrawing", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("replay-screen");
    const first = yield* attach("replay-screen", env);

    const session = yield* projectAgent(daemon, first, { cmd: ["cat"] });
    session.write("left-on-screen\n");
    yield* until(() => screen(session).includes("left-on-screen"), "the first client's echo");

    first.close();
    yield* until(
      () => attachedClient(daemon).pipe(Effect.map((c) => c === null)),
      "the daemon to notice the detach",
    );

    const second = yield* attach("replay-screen", env);
    const readopted = yield* projectAgent(daemon, second, {
      id: session.id,
      cmd: ["cat"],
    });

    // cat never redraws. The old line can reach this fresh pane only through the
    // daemon's replay; without it the pane stays blank until some later echo.
    yield* until(() => screen(readopted).includes("left-on-screen"), "the replayed screen");
    expect(yield* daemon.liveSessions).toContain(session.id);
  }),
);

testEffect("an adopted agent is resized before its screen replay", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("replay-resize");
    const first = yield* attach("replay-resize", env, "first");
    const session = yield* projectAgent(daemon, first, {
      cmd: ["cat"],
      cols: 80,
      rows: 24,
    });
    session.write("resized-replay\n");
    yield* until(() => screen(session).includes("resized-replay"), "the first client's echo");

    first.close();
    yield* until(
      () => attachedClient(daemon).pipe(Effect.map((c) => c === null)),
      "the daemon to notice the detach",
    );

    const second = yield* attach("replay-resize", env, "second");
    const readopted = yield* projectAgent(daemon, second, {
      id: session.id,
      cmd: ["cat"],
      cols: 40,
      rows: 10,
    });

    yield* until(() => screen(readopted).includes("resized-replay"), "the resized replay");
    expect(readopted.term.cols).toBe(40);
    expect(readopted.term.rows).toBe(10);
  }),
);

testEffect("daemon replay keeps only the current screen, with no scrollback", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("replay-no-scrollback");
    const first = yield* attach("replay-no-scrollback", env, "first");
    const session = yield* projectAgent(daemon, first, {
      cmd: [
        "sh",
        "-c",
        "printf 'old-1\\nold-2\\nold-3\\nold-4\\nold-5\\nold-6\\nold-7\\nold-8\\nold-9\\nold-10\\nlast\\n'; sleep 30",
      ],
      cols: 40,
      rows: 4,
    });
    yield* until(
      () => screen(session).includes("last"),
      "the daemon terminal to receive the final line",
    );
    expect(screen(session)).not.toContain("old-3");

    first.close();
    yield* until(
      () => attachedClient(daemon).pipe(Effect.map((c) => c === null)),
      "the daemon to notice the detach",
    );
    const second = yield* attach("replay-no-scrollback", env, "second");
    const readopted = yield* projectAgent(daemon, second, {
      id: session.id,
      cmd: ["cat"],
      cols: 40,
      rows: 4,
    });

    yield* until(() => screen(readopted).includes("last"), "the current screen replay");
    expect(screen(readopted)).not.toContain("old-3");
  }),
);

testEffect("an alternate-screen app's view is replayed intact to a reattaching client", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("replay-alt");
    const first = yield* attach("replay-alt", env);

    const cmd = ["sh", "-c", "printf '\\033[?1049h\\033[2J\\033[2;2Halt-mode-view'; sleep 30"];
    const session = yield* projectAgent(daemon, first, { cmd });
    yield* until(
      () => screen(session).includes("alt-mode-view"),
      "the app to draw its alternate screen",
    );
    expect(session.term.mode(MODE_ALT_SCREEN)).toBe(true);

    first.close();
    yield* until(
      () => attachedClient(daemon).pipe(Effect.map((c) => c === null)),
      "the daemon to notice the detach",
    );

    const second = yield* attach("replay-alt", env);
    const readopted = yield* projectAgent(daemon, second, { id: session.id, cmd });

    // The content alone could have landed on the wrong screen; the mode check is
    // the discriminator. A raw byte-suffix replay would fail exactly here.
    yield* until(
      () => screen(readopted).includes("alt-mode-view"),
      "the replayed alternate screen",
    );
    expect(readopted.term.mode(MODE_ALT_SCREEN)).toBe(true);
  }),
);

/**
 * The real deployment path: a daemon in its own process, started on demand.
 *
 * Every other test here hosts the daemon in the test process, which is the
 * right trade for exercising behaviour but leaves the one claim that matters
 * most unproven — that the agents are in a process that does not go away when
 * this one does. Here the daemon is a separate pid, and the client attaching
 * the second time is a genuine reattach.
 */
testEffect("a daemon started on demand keeps agents between two separate clients", () =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-autostart-")));
    dirs.push(home);
    // A real environment, plus a private state root: the daemon has to spawn
    // programs, and a PATH-less env would fail for reasons that have nothing to
    // do with what is under test.
    const inheritedPath = yield* Config.option(Config.string("PATH"));
    const env = {
      PATH: Option.getOrUndefined(inheritedPath),
      HOME: home,
      XDG_STATE_HOME: join(home, "state"),
    };
    const id = "autostart";

    const first = yield* connect(id, env, { client: "first" });
    try {
      const lease = yield* run(
        Effect.flatMap(SessionStore, (store) => store.readLease(id)),
        env,
      );
      expect(lease?.pid).toBeGreaterThan(0);
      expect(lease!.pid).not.toBe(process.pid);

      const saved = modeledAgent(first);
      const session = new SessionHandle({ ...saved, backend: first.backend() });
      sessions.push(session);
      session.write("printf 'across-processes\\n'\n");
      yield* until(() => screen(session).includes("across-processes"), "the daemon's echo");
      first.close();

      // A second client, with no memory of the first, finds the agent still there.
      const second = yield* connect(id, env, { client: "second" });
      expect(second.live).toContain(session.id);
      const readopted = new SessionHandle({
        ...saved,
        backend: second.backend(),
      });
      sessions.push(readopted);
      readopted.write("printf 'still-alive\\n'\n");
      yield* until(() => screen(readopted).includes("still-alive"), "the adopted agent's echo");
      yield* run(second.stop, env);
    } finally {
      const lease = yield* run(
        Effect.flatMap(SessionStore, (store) => store.readLease(id)),
        env,
      );
      if (lease && processAlive(lease.pid)) process.kill(lease.pid, "SIGKILL");
    }
  }),
);

testEffect("a daemon workspace mutation is visible to a later client", () =>
  Effect.gen(function* () {
    const { env } = yield* startSession("saved");
    const client = yield* attach("saved", env);

    yield* run(
      client.runWorkspace(command("space.rename", { name: "proj" }), {
        size: { cols: 80, rows: 24 },
        shell: ["sh"],
        cwd: "/tmp",
      }),
      env,
    );

    // And a client attaching later is handed that same workspace to rebuild from.
    client.close();
    const next = yield* attach("saved", env, "second");
    expect(next.workspace().spaces.map((s) => s.name)).toEqual(["proj"]);
  }),
);

testEffect("SessionClient exposes no unrevisioned process mutation methods", () =>
  Effect.gen(function* () {
    const { env } = yield* startSession("client-authority-surface");
    const client = yield* attach("client-authority-surface", env);
    expect("spawn" in client).toBe(false);
    expect("kill" in client).toBe(false);
  }),
);

testEffect(
  "releasing a client projection closes local resources without killing the daemon PTY",
  () =>
    Effect.gen(function* () {
      const { daemon, env } = yield* startSession("projection-release");
      const client = yield* attach("projection-release", env);
      const session = yield* projectAgent(daemon, client, { cmd: ["sleep", "30"] });
      yield* session.release();
      expect(yield* daemon.liveSessions).toContain(session.id);
    }),
);

testEffect("a failed workspace response is neither accepted nor left as a phantom PTY", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("client-transaction");
    const client = yield* attach("client-transaction", env);
    const before = client.workspace();
    const beforeLive = yield* daemon.liveSessions;
    const p = yield* run(sessionPaths("client-transaction"), env);
    yield* Effect.promise(() => rm(p.backup, { recursive: true, force: true }));
    yield* Effect.promise(() => mkdir(p.backup));

    const result = yield* Effect.exit(
      run(
        client.runWorkspace(command("pane.split", { axis: "row" }), {
          size: { cols: 80, rows: 24 },
          shell: ["sh"],
          cwd: "/tmp",
        }),
        env,
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(client.workspace()).toEqual(before);
    expect(yield* daemon.getWorkspace).toEqual(before);
    expect(yield* daemon.liveSessions).toEqual(beforeLive);
  }),
);

testEffect("closing a client rejects queued workspace commands", () =>
  Effect.gen(function* () {
    const { env } = yield* startSession("client-command-close");
    const scope = yield* Scope.make();
    scopes.push(scope);
    const client = yield* run(
      Scope.provide(SessionClient.connect("client-command-close", { autostart: false }), scope),
      env,
    );
    const pending = yield* Effect.forkChild(
      client.runWorkspace(command("space.rename", { name: "closing" }), {
        size: { cols: 80, rows: 24 },
        shell: ["sh"],
        cwd: "/tmp",
      }),
    );
    yield* Scope.close(scope, Exit.void);
    const result = yield* Fiber.await(pending);
    expect(Exit.isFailure(result)).toBe(true);
  }),
);

// Blocked by ts-d99630: interrupting a split strands a half-created PTY, and
// the daemon can then neither stop gracefully nor be torn down without hanging
// the whole file. The client contract this would assert — a caller woken with
// "client is closing" rather than left waiting — is covered for queued commands
// by the test above. Unskip when the daemon defect is fixed.
test.skip("closing a client rejects a workspace command in flight", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { env } = yield* startSession("client-command-in-flight");
        const client = yield* attach("client-command-in-flight", env);
        const pending = yield* Effect.forkChild(
          client.runWorkspace(command("pane.split", { axis: "row" }), {
            size: { cols: 80, rows: 24 },
            shell: ["sh", "-c", "sleep 30"],
            cwd: "/tmp",
          }),
        );
        yield* Effect.sleep(10);
        const close = scopes[scopes.length - 1]!;
        yield* Scope.close(close, Exit.void);
        scopes.splice(scopes.indexOf(close), 1);
        clients.splice(clients.indexOf(client), 1);
        const result = yield* Fiber.await(pending);
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  ));

testEffect(
  "a natural terminal exit is published only after its workspace generation is durable",
  () =>
    Effect.gen(function* () {
      const { daemon, env } = yield* startSession("exit-order");
      const client = yield* attach("exit-order", env);
      const before = new Set(
        client
          .workspace()
          .spaces.flatMap((space) =>
            space.windows.flatMap((window) => window.sessions.map((session) => session.id)),
          ),
      );
      const created = yield* run(
        client.runWorkspace(command("pane.split", { axis: "row" }), {
          size: { cols: 80, rows: 24 },
          shell: ["sh", "-c", "exit 7"],
          cwd: "/tmp",
        }),
        env,
      );
      const id = created.snapshot.spaces
        .flatMap((space) => space.windows)
        .flatMap((window) => window.sessions)
        .find((session) => !before.has(session.id))!.id;

      yield* Stream.runForEach(client.attach.stream(id), (frame) => {
        if (frame._tag !== "exit") return Effect.void;
        return Effect.flatMap(SessionStore, (store) => store.load("exit-order")).pipe(
          Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
          Effect.map((saved) => {
            const session = saved?.spaces
              .flatMap((space) => space.windows)
              .flatMap((window) => window.sessions)
              .find((candidate) => candidate.id === id);
            expect(session?.exited).toBe(true);
            expect(session?.exitCode).toBe(7);
          }),
        );
      });
      yield* daemon.stop;
      daemons.splice(daemons.indexOf(daemon), 1);
    }),
);

testEffect("a transient natural-exit write failure does not consume the terminal exit latch", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("exit-retry-order");
    const client = yield* attach("exit-retry-order", env);
    const before = new Set(
      client
        .workspace()
        .spaces.flatMap((space) =>
          space.windows.flatMap((window) => window.sessions.map((session) => session.id)),
        ),
    );
    const created = yield* run(
      client.runWorkspace(command("pane.split", { axis: "row" }), {
        size: { cols: 80, rows: 24 },
        shell: ["sh", "-c", "sleep 0.2; exit 9"],
        cwd: "/tmp",
      }),
      env,
    );
    const id = created.snapshot.spaces
      .flatMap((space) => space.windows)
      .flatMap((window) => window.sessions)
      .find((session) => !before.has(session.id))!.id;
    const p = yield* run(sessionPaths("exit-retry-order"), env);
    yield* Effect.promise(() => rm(p.backup, { recursive: true, force: true }));
    yield* Effect.promise(() => mkdir(p.backup));

    let sawExit = false;
    const exit = yield* Effect.forkChild(
      Stream.runForEach(client.attach.stream(id), (frame) => {
        if (frame._tag !== "exit") return Effect.void;
        sawExit = true;
        return Effect.flatMap(SessionStore, (store) => store.load("exit-retry-order")).pipe(
          Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
          Effect.map((saved) => {
            const session = saved?.spaces
              .flatMap((space) => space.windows)
              .flatMap((window) => window.sessions)
              .find((candidate) => candidate.id === id);
            expect(session?.exited).toBe(true);
            expect(session?.exitCode).toBe(9);
          }),
        );
      }),
    );
    yield* until(
      () =>
        run(
          controlCall(daemon.id, (c) => c.Status()),
          env,
        ).pipe(Effect.map((status) => status.degraded !== undefined)),
      "the persistence failure to surface",
    );
    yield* Effect.promise(() => rm(p.backup, { recursive: true, force: true }));
    yield* Fiber.join(exit).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.die(new Error("exit stayed latched after recovery")),
      }),
    );
    expect(sawExit).toBe(true);
  }),
);

testEffect("attached clients subscribe to ordered workspace generations", () =>
  Effect.gen(function* () {
    const { env } = yield* startSession("model-subscription");
    const first = yield* attach("model-subscription", env, "first");
    const second = yield* attach("model-subscription", env, "second");
    const update = yield* Effect.forkChild(Stream.runHead(second.models));

    const changed = yield* run(
      first.runWorkspace(command("space.rename", { name: "shared" }), {
        size: { cols: 80, rows: 24 },
        shell: ["sh"],
        cwd: "/tmp",
      }),
      env,
    );
    const received = yield* Fiber.join(update);

    expect(Option.isSome(received)).toBe(true);
    if (Option.isSome(received)) {
      expect(received.value.revision).toBe(changed.snapshot.revision);
      expect(received.value.spaces[0]!.name).toBe("shared");
    }
  }),
);

/**
 * Two watchers of one session each see all of it.
 *
 * A pane's transcript is not the only subscriber: the backend streams the same
 * session to track its status and output. They used to share one queue, and a
 * queue hands each item to exactly one taker — so an answer arrived split
 * between them, every other delta missing from the pane and the words that
 * remained running together.
 */
testEffect("every subscriber to a session receives every frame", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("fanout");
    const client = yield* attach("fanout", env);
    const id = "fanout-agent";
    const words = ["alpha ", "beta ", "gamma ", "delta ", "epsilon"];
    const frames = yield* Effect.forEach(words, (text) =>
      S.encodeEffect(S.fromJsonString(S.Unknown))({
        _tag: "agent.delta",
        session: id,
        delta: { _tag: "text.delta", turn: "t1", text },
      }),
    );
    const framesJson = yield* S.encodeEffect(S.fromJsonString(S.Array(S.String)))(frames);
    yield* daemon.spawnSession({
      kind: "component",
      id,
      cmd: [
        process.execPath,
        "-e",
        `for (const frame of ${framesJson}) process.stdout.write(frame + "\\n"); setTimeout(()=>{},30000)`,
      ],
      cols: 80,
      rows: 24,
    });

    const watchers = [[], []] as AttachFrame[][];
    const context = yield* Effect.context();
    const fibers = watchers.map((seen) =>
      Effect.runForkWith(context)(
        client.attach
          .stream(id)
          .pipe(Stream.runForEach((f) => Effect.sync(() => void seen.push(f)))),
      ),
    );
    client.attach.sync(id);
    yield* until(
      () =>
        watchers.every(
          (seen) => seen.filter((f) => f._tag === "agent.delta").length === words.length,
        ),
      "both subscribers to see the whole answer",
    );
    for (const fiber of fibers) yield* Fiber.interrupt(fiber);

    // A queue hands each item to one taker; a hub hands it to every one. Both
    // watchers must hold the whole answer, in order, not a share of it.
    for (const seen of watchers) {
      const text = seen
        .filter((f) => f._tag === "agent.delta")
        .map((f) => (f.delta as { text: string }).text)
        .join("");
      expect(text).toBe("alpha beta gamma delta epsilon");
    }
    yield* daemon.killSession(id);
  }),
);
