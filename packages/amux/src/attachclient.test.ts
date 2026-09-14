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
import type { PlatformError } from "effect/PlatformError";
import { BunFileSystem } from "@effect/platform-bun";
import { which } from "bun";
import { SessionHandle, type SessionHandleOptions } from "./session-handle.ts";
type SessionOptions = SessionHandleOptions;
import type { PersistedSession } from "./session.ts";
import { AttachClient, type AttachClientContract } from "./attach.ts";
import type { SessionBackend } from "./backend.ts";
import { SessionClient, type SessionClientContract } from "./client.ts";
import { startDaemon, type SessionDaemonOptions, type SessionDaemonService } from "./daemon.ts";
import { captureVisible } from "./capture.ts";
import { sessionPaths, SessionStore } from "./session.ts";
import { Schema as S, Stream } from "effect";
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
  AgentFrame,
} from "./effect/AttachProtocol.ts";
import { command } from "./commands.ts";
import { controlCall } from "./control-client.ts";
import { registerCleanup, tempDir } from "./test-tmp.ts";
import { testEffect } from "./test-effect.ts";
import { until } from "./test-wait.ts";
import { layoutRefs } from "./layout.ts";
import type { Config as AmuxConfig } from "./config.ts";
import { provideDaemon as run } from "./test-daemon.ts";

registerCleanup();

const editorPlugin = new URL("../../editor", import.meta.url).pathname;
const editorPluginConfig: AmuxConfig = {
  options: {},
  keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
  plugins: [{ path: editorPlugin, enabled: true }],
  permissions: [],
  layoutRules: [],
};

/** A live `SessionHandle` as the persisted entry an attach frame carries. The
 *  client no longer serializes workspaces itself — the daemon owns that — but
 *  the exited flag must survive the round trip, so an attached agent that is
 *  still running never reads back as a tombstone. */
function snapshotSessionEntry(session: SessionHandle): PersistedSession {
  const entry: PersistedSession = {
    id: session.id,
    name: session.name,
    cols: session.term.cols,
    rows: session.term.rows,
    exited: session.exited,
    exitCode: session.exitCode,
  };
  if (session.kind === "component") Object.assign(entry, { kind: "component" as const });
  if (session.declaredAgent) Object.assign(entry, { declaredAgent: session.declaredAgent });
  if (session.cmd.length > 0) Object.assign(entry, { cmd: [...session.cmd] });
  if (session.provider) Object.assign(entry, { provider: session.provider });
  if (session.cwd) Object.assign(entry, { cwd: session.cwd });
  return entry;
}

const join = (...paths: string[]) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.join(...paths)).pipe(Effect.provide(Path.layer)),
  );
const fsRun = <A>(effect: Effect.Effect<A, PlatformError, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)));
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

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const session of sessions.splice(0)) session.dispose();
      for (const client of clients.splice(0)) client.close();
      for (const scope of scopes.splice(0))
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      for (const daemon of daemons.splice(0)) yield* daemon.stop.pipe(Effect.ignore);
    }),
  ),
);
const startSession = Effect.fnUntraced(function* (id: string, options: SessionDaemonOptions = {}) {
  const home = tempDir("client");
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
  } as NodeJS.ProcessEnv;
  const daemon = yield* run(Effect.scoped(startDaemon(id, options)), env);
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
  const projected = yield* SessionHandle.make({
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

/** What the agent's terminal is actually showing, as text. The app's own
 *  capture path, so these assertions read the screen the user would. */
const screen = (session: SessionHandle) => captureVisible(session.term);

testEffect("native agent status frames become authoritative projected state", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("native-status");
    const client = yield* attach("native-status", env);
    const cmd = [
      process.execPath,
      "-e",
      `process.stdout.write(JSON.stringify({_tag:"agent.emit",event:{_tag:"topic",session:"native-status-agent",topic:"session.state",payload:"running"}})+"\\n"); setTimeout(()=>{},5000)`,
    ];
    yield* daemon.spawnSession({
      kind: "component",
      id: "native-status-agent",
      cmd,
      cols: 80,
      rows: 24,
    });
    (client.live as Set<string>).add("native-status-agent");
    const session = yield* SessionHandle.make({
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
      `process.stdout.write(${emittedLine}); setTimeout(()=>{},5000)`,
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
  const dir = tempDir("daemon-agent");
  const path = join(dir, name);
  const bash = which("bash");
  if (!bash) return yield* Effect.die(new Error("no bash on PATH to impersonate"));
  yield* Effect.promise(() => Bun.write(path, Bun.file(bash)));
  yield* Effect.promise(() => chmod(path, 0o755));
  return path;
});

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
    const home = tempDir("generations");
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
    const home = tempDir("unacquired");
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
    const home = tempDir("overflow");
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
    const home = tempDir("handshake-timeout");
    const path = join(home, "attach.sock");
    let closed = 0;
    let latePongs = 0;
    let settlements = 0;
    let resurrected: AttachClientContract | null = null;
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
    yield* until(() => settlements === 2, "both acquire attempts to settle");
    expect(settlements).toBe(2);
    expect(closed).toBe(2);
    expect(resurrected).toBeNull();
    listener.stop(true);
  }),
);

testEffect("the connection scope emits heartbeats and stops them when released", () =>
  Effect.gen(function* () {
    const home = tempDir("heartbeat");
    const path = join(home, "attach.sock");
    let buffer = "";
    let beats = 0;
    let closes = 0;
    let finalized = 0;
    let client: AttachClientContract | null = null;
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
    const home = tempDir("handshake-error");
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

testEffect("a projection of an unmodeled id never asks the daemon to spawn it", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("unreachable");
    const client = yield* attach("unreachable", env);

    const before = yield* daemon.liveSessions;
    const session = yield* SessionHandle.make({
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

test("SessionClient exposes no unrevisioned process mutation methods", () => {
  expect("spawn" in SessionClient).toBe(false);
  expect("kill" in SessionClient).toBe(false);
  type Forbidden = Extract<keyof SessionClientContract, "spawn" | "kill">;
  const noUnrevisioned: [Forbidden] extends [never] ? true : false = true;
  expect(noUnrevisioned).toBe(true);
});

testEffect(
  "releasing a client projection closes local resources without killing the daemon PTY",
  () =>
    Effect.gen(function* () {
      let closeCalled = false;
      let killCalled = false;
      const session = yield* SessionHandle.make({
        id: "projection-release",
        cmd: ["sleep", "30"],
        backend: (): SessionBackend => ({
          get closed() {
            return closeCalled;
          },
          detached: false,
          exitCode: null,
          stream: Stream.never,
          write() {},
          resize() {},
          close() {
            closeCalled = true;
          },
          kill() {
            killCalled = true;
          },
          foregroundPgid: () => -1,
          sessionId: () => -1,
        }),
      });
      sessions.push(session);
      yield* session.release();
      expect(closeCalled).toBe(true);
      expect(killCalled).toBe(false);
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
    const home = tempDir("fanout");
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
        client: "fanout-test",
      }),
    );

    const id = "fanout-agent";
    const words = ["alpha ", "beta ", "gamma ", "delta ", "epsilon"];
    const watchers = [[], []] as AttachFrame[][];
    const fibers = yield* Effect.forEach(watchers, (seen) =>
      Effect.forkChild(
        client.stream(id).pipe(Stream.runForEach((f) => Effect.sync(() => void seen.push(f)))),
      ),
    );
    yield* Effect.sleep(0);
    peer!.write(
      words
        .map((text) =>
          encodeAttachFrame({
            _tag: "output",
            session: id,
            data: new TextEncoder().encode(text),
          }),
        )
        .join(""),
    );
    yield* until(
      () =>
        watchers.every((seen) => seen.filter((f) => f._tag === "output").length === words.length),
      "both subscribers to see the whole answer",
    );
    for (const fiber of fibers) yield* Fiber.interrupt(fiber);

    // A queue hands each item to one taker; a hub hands it to every one. Both
    // watchers must hold the whole answer, in order, not a share of it.
    for (const seen of watchers) {
      const text = seen
        .filter((f): f is Extract<AttachFrame, { _tag: "output" }> => f._tag === "output")
        .map((f) => Buffer.from(f.data).toString())
        .join("");
      expect(text).toBe("alpha beta gamma delta epsilon");
    }
    client.close();
    listener.stop(true);
  }),
);

/**
 * Sessionless plugin capture is answered by the attached client the CLI Batch
 * (or attach run) routes to — the daemon has no pty grid for that leaf. Stub
 * the client's command surface so the RPC path is what is under test, not
 * OpenTUI pixels.
 */
testEffect("pane.capture of a plugin pane returns what the attached client answers", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("plugin-capture-client", {
      pluginConfig: editorPluginConfig,
    });
    const client = yield* attach("plugin-capture-client", env);
    yield* Effect.forkScoped(
      Stream.runForEach(client.commandRequests, ({ id, command: raw }) =>
        Effect.sync(() => {
          const tag =
            raw && typeof raw === "object" && "_tag" in raw
              ? String((raw as { _tag: unknown })._tag)
              : "";
          if (tag === "pane.capture") client.respondCommand(id, "plugin-frame-text");
          else client.respondCommand(id, undefined, `unexpected ${tag}`);
        }),
      ),
    );

    const opened = yield* run(
      controlCall(daemon.id, (c) =>
        c.Batch({
          values: [
            command("pane.open-plugin", {
              type: "amux.editor",
              descriptor: { file: "/note.txt" },
            }),
          ],
          context: {
            size: { cols: 80, rows: 24 },
            shell: ["sh"],
            cwd: "/tmp",
            source: "socket",
          },
        }),
      ),
      env,
    );
    const pane = (opened.outputs[0]!.result as { pane: string }).pane;

    const captured = yield* run(
      controlCall(daemon.id, (c) =>
        c.Batch({
          values: [command("pane.capture", { pane })],
          context: {
            size: { cols: 80, rows: 24 },
            shell: ["sh"],
            cwd: "/tmp",
            source: "socket",
          },
        }),
      ),
      env,
    );
    expect(captured.outputs[0]!.result).toBe("plugin-frame-text");
  }),
);

/**
 * A key-sourced client-target command must run on the pressing connection, not
 * connections[0]. Two attached clients: only the second answers.
 */
testEffect("key-sourced client command runs on the pressing client, not the first attached", () =>
  Effect.gen(function* () {
    const { env } = yield* startSession("attach-key-client-target", {
      pluginConfig: editorPluginConfig,
    });
    const first = yield* attach("attach-key-client-target", env, "first");
    const second = yield* attach("attach-key-client-target", env, "second");
    let firstHits = 0;
    let secondHits = 0;
    yield* Effect.forkScoped(
      Stream.runForEach(first.commandRequests, ({ id, command: raw }) =>
        Effect.sync(() => {
          const tag =
            raw && typeof raw === "object" && "_tag" in raw
              ? String((raw as { _tag: unknown })._tag)
              : "";
          if (tag === "pane.capture") {
            firstHits += 1;
            first.respondCommand(id, "from-first");
          } else first.respondCommand(id, undefined, `unexpected ${tag}`);
        }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(second.commandRequests, ({ id, command: raw, source }) =>
        Effect.sync(() => {
          const tag =
            raw && typeof raw === "object" && "_tag" in raw
              ? String((raw as { _tag: unknown })._tag)
              : "";
          if (tag === "pane.capture") {
            expect(source).toBe("key");
            secondHits += 1;
            second.respondCommand(id, "from-second");
          } else second.respondCommand(id, undefined, `unexpected ${tag}`);
        }),
      ),
    );

    const opened = yield* run(
      first.runWorkspace(
        command("pane.open-plugin", {
          type: "amux.editor",
          descriptor: { file: "/note.txt" },
        }),
        {
          size: { cols: 80, rows: 24 },
          shell: ["sh"],
          cwd: "/tmp",
          source: "socket",
        },
      ),
      env,
    );
    const pane = (opened.result as { pane: string }).pane;

    const captured = yield* run(
      second.run(command("pane.capture", { pane }), {
        size: { cols: 80, rows: 24 },
        shell: ["sh"],
        cwd: "/tmp",
        source: "key",
        pane,
      }),
      env,
    );
    expect(captured).toBe("from-second");
    expect(secondHits).toBe(1);
    expect(firstHits).toBe(0);
  }),
);

/**
 * A key-sourced client-target command holds the attach round-trip open while
 * its handler runs. That handler must be able to issue another session command
 * (runWorkspace) without deadlocking on the client's serial command queue —
 * `run` must not share that queue with `runWorkspace`.
 */
testEffect("key client command whose handler runs a nested session command completes", () =>
  Effect.gen(function* () {
    const { env } = yield* startSession("attach-nested-run", {
      pluginConfig: editorPluginConfig,
    });
    const client = yield* attach("attach-nested-run", env);
    let outerHits = 0;
    let nestedHits = 0;
    yield* Effect.forkScoped(
      Stream.runForEach(client.commandRequests, ({ id, command: raw, source }) =>
        Effect.gen(function* () {
          const tag =
            raw && typeof raw === "object" && "_tag" in raw
              ? String((raw as { _tag: unknown })._tag)
              : "";
          if (tag !== "pane.capture") {
            client.respondCommand(id, undefined, `unexpected ${tag}`);
            return;
          }
          expect(source).toBe("key");
          outerHits += 1;
          const renamed = yield* client.runWorkspace(
            command("space.rename", { name: "nested-from-handler" }),
            {
              size: { cols: 80, rows: 24 },
              shell: ["sh"],
              cwd: "/tmp",
              source: "key",
            },
          );
          nestedHits += 1;
          expect(renamed.snapshot.spaces[0]!.name).toBe("nested-from-handler");
          client.respondCommand(id, "captured-after-nested");
        }),
      ),
    );

    const opened = yield* run(
      client.runWorkspace(
        command("pane.open-plugin", {
          type: "amux.editor",
          descriptor: { file: "/note.txt" },
        }),
        {
          size: { cols: 80, rows: 24 },
          shell: ["sh"],
          cwd: "/tmp",
          source: "socket",
        },
      ),
      env,
    );
    const pane = (opened.result as { pane: string }).pane;

    const captured = yield* run(
      client.run(command("pane.capture", { pane }), {
        size: { cols: 80, rows: 24 },
        shell: ["sh"],
        cwd: "/tmp",
        source: "key",
        pane,
      }),
      env,
    );
    expect(captured).toBe("captured-after-nested");
    expect(outerHits).toBe(1);
    expect(nestedHits).toBe(1);
  }),
);

testEffect("the daemon answers a live pane's cursor-position query into the PTY", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("query-reply");
    const client = yield* attach("query-reply", env);
    const dir = tempDir("query-reply");
    const resultPath = `${dir}/result.hex`;
    const quotedResultPath = yield* S.encodeEffect(S.fromJsonString(S.String))(resultPath);
    // Raw mode + CSI 6 n: without WRITE_PTY the read times out empty.
    // select budget is generous — under full-suite load the daemon's reply
    // to DSR can land after a quiet-machine 2s window (empty hex once in 1547).
    yield* projectAgent(daemon, client, {
      cmd: [
        "python3",
        "-c",
        [
          "import os,termios,tty,select",
          "old=termios.tcgetattr(0)",
          "tty.setraw(0)",
          "os.write(1,b'\\x1b[6n')",
          "ready,_,_=select.select([0],[],[],10)",
          "resp=os.read(0,32) if ready else b''",
          "termios.tcsetattr(0,termios.TCSANOW,old)",
          `open(${quotedResultPath},'wb').write(resp.hex().encode())`,
        ].join(";"),
      ],
      cols: 40,
      rows: 10,
    });
    yield* until(
      () =>
        Bun.file(resultPath)
          .exists()
          .then((ok) => ok && Bun.file(resultPath).size > 0),
      "the query probe to finish with a DSR reply",
      15_000,
    );
    const hex = yield* Effect.tryPromise(() => Bun.file(resultPath).text());
    expect(hex.length).toBeGreaterThan(0);
    expect(Buffer.from(hex, "hex").toString()).toMatch(
      new RegExp(`^${String.fromCharCode(0x1b)}\\[\\d+;\\d+R$`),
    );
  }),
);

testEffect("unnamed client-routed send-keys pins the calling pane, not focus", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("client-route-caller-pane");
    const client = yield* attach("client-route-caller-pane", env);
    let seen: unknown;
    yield* Effect.forkScoped(
      Stream.runForEach(client.commandRequests, ({ id, command: raw }) =>
        Effect.sync(() => {
          seen = raw;
          client.respondCommand(id, undefined);
        }),
      ),
    );

    const before = yield* daemon.getWorkspace;
    const paneA = layoutRefs(before.spaces[0]!.windows[0]!.layout)[0]!.id;

    const split = yield* run(
      controlCall(daemon.id, (c) =>
        c.Batch({
          values: [command("pane.split", { axis: "row" })],
          context: {
            size: { cols: 80, rows: 24 },
            shell: ["sh"],
            cwd: "/tmp",
            source: "socket",
          },
        }),
      ),
      env,
    );
    const paneB = (split.outputs[0]!.result as { pane: string }).pane;
    const afterSplit = yield* daemon.getWorkspace;
    expect(afterSplit.spaces[0]!.windows[0]!.state.focus).toBe(paneB);

    yield* run(
      controlCall(daemon.id, (c) =>
        c.Batch({
          values: [command("pane.send-keys", { keys: "x", dispatch: true })],
          context: {
            size: { cols: 80, rows: 24 },
            shell: ["sh"],
            cwd: "/tmp",
            source: "cli",
            pane: paneA,
          },
        }),
      ),
      env,
    );
    expect(seen).toMatchObject({
      _tag: "pane.send-keys",
      keys: "x",
      dispatch: true,
      pane: paneA,
    });
  }),
);

/**
 * plugin.inspect's pane field is a subject, not a PaneTarget — the daemon must
 * not pin a caller pane onto it. Bare inspect and subject forms pass through.
 */
testEffect("plugin.inspect subject forms are not given a pinned caller pane", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* startSession("client-route-inspect-subjects");
    const client = yield* attach("client-route-inspect-subjects", env);
    const seen: unknown[] = [];
    yield* Effect.forkScoped(
      Stream.runForEach(client.commandRequests, ({ id, command: raw }) =>
        Effect.sync(() => {
          seen.push(raw);
          const tag =
            raw && typeof raw === "object" && "_tag" in raw
              ? String((raw as { _tag: unknown })._tag)
              : "";
          if (tag !== "plugin.inspect") {
            client.respondCommand(id, undefined, `unexpected ${tag}`);
            return;
          }
          const q = raw as {
            plugin?: string;
            command?: string;
            pane?: string;
          };
          if (q.pane !== undefined) {
            client.respondCommand(id, undefined, "pane must not be pinned onto inspect");
            return;
          }
          if (q.plugin !== undefined) {
            client.respondCommand(id, {
              kind: "plugin",
              name: q.plugin,
              found: true,
            });
            return;
          }
          if (q.command !== undefined) {
            client.respondCommand(id, {
              kind: "command",
              name: q.command,
              found: true,
            });
            return;
          }
          client.respondCommand(
            id,
            undefined,
            "plugin.inspect needs one of: command, binding, key, pane, plugin",
          );
        }),
      ),
    );

    const before = yield* daemon.getWorkspace;
    const paneA = layoutRefs(before.spaces[0]!.windows[0]!.layout)[0]!.id;
    const split = yield* run(
      controlCall(daemon.id, (c) =>
        c.Batch({
          values: [command("pane.split", { axis: "row" })],
          context: {
            size: { cols: 80, rows: 24 },
            shell: ["sh"],
            cwd: "/tmp",
            source: "socket",
          },
        }),
      ),
      env,
    );
    const paneB = (split.outputs[0]!.result as { pane: string }).pane;
    expect((yield* daemon.getWorkspace).spaces[0]!.windows[0]!.state.focus).toBe(paneB);

    const caller = {
      size: { cols: 80, rows: 24 },
      shell: ["sh"] as const,
      cwd: "/tmp",
      source: "cli" as const,
      pane: paneA,
    };

    const byPlugin = yield* run(
      controlCall(daemon.id, (c) =>
        c.Batch({
          values: [command("plugin.inspect", { plugin: "amux" })],
          context: caller,
        }),
      ),
      env,
    );
    expect(byPlugin.outputs[0]!.result).toMatchObject({
      kind: "plugin",
      name: "amux",
      found: true,
    });

    const byCommand = yield* run(
      controlCall(daemon.id, (c) =>
        c.Batch({
          values: [command("plugin.inspect", { command: "pane.zoom" })],
          context: caller,
        }),
      ),
      env,
    );
    expect(byCommand.outputs[0]!.result).toMatchObject({
      kind: "command",
      name: "pane.zoom",
      found: true,
    });

    const bare = yield* run(
      Effect.flip(
        controlCall(daemon.id, (c) =>
          c.Batch({
            values: [command("plugin.inspect")],
            context: caller,
          }),
        ),
      ),
      env,
    );
    expect(bare._tag).toBe("ControlError");
    expect(bare.message).toContain("plugin.inspect needs one of");

    expect(seen).toEqual([
      { _tag: "plugin.inspect", plugin: "amux" },
      { _tag: "plugin.inspect", command: "pane.zoom" },
      { _tag: "plugin.inspect" },
    ]);
  }),
);

testEffect("a view command on the attach run path is refused", () =>
  Effect.gen(function* () {
    const { env } = yield* startSession("attach-view-refused");
    const client = yield* attach("attach-view-refused", env);
    const error = yield* run(
      Effect.flip(
        client.attach.runCommand(command("app.command-palette") as never, {
          context: {
            size: { cols: 80, rows: 24 },
            shell: ["sh"],
            cwd: "/tmp",
            source: "key",
          },
        }),
      ),
      env,
    );
    expect(error.message).toContain("view command");
  }),
);
