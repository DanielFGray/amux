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
import { ConfigProvider, Effect, Exit, pipe, Scope } from "effect";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";
import { Session, type SessionOptions } from "./agent.ts";
import { snapshotSessionEntry } from "./snapshot.ts";
import { AttachClient } from "./attach.ts";
import { SessionClient, type SessionClientShape } from "./client.ts";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { captureVisible } from "./capture.ts";
import { MODE_ALT_SCREEN } from "./ghostty.ts";
import { processAlive, sessionPaths, SessionStore } from "./session.ts";
import { Option, Stream } from "effect";
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "./effect/AttachProtocol.ts";
import { command } from "./commands.ts";
import { controlCall } from "./control-client.ts";

const dirs: string[] = [];
const daemons: SessionDaemonService[] = [];
const attachedClient = (d: SessionDaemonService) => Effect.runPromise(d.getAttachedClient);
const attachedClients = (d: SessionDaemonService) => Effect.runPromise(d.getAttachedClients);
const clients: SessionClientShape[] = [];
/** A client's control and attach sockets live in its scope, so tests own one. */
const scopes: Scope.CloseableScope[] = [];
const connect = (
  id: string,
  env: NodeJS.ProcessEnv,
  options: { client?: string; autostart?: boolean } = {},
) => {
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  return run(Scope.extend(SessionClient.connect(id, options), scope), env);
};
const agents: Session[] = [];
let nextProjection = 0;
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

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.dispose();
  for (const client of clients.splice(0)) client.close();
  for (const scope of scopes.splice(0))
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop).catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function session(id: string) {
  const home = await mkdtemp(join(tmpdir(), "amux-client-"));
  dirs.push(home);
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv;
  const daemon = await run(Effect.scoped(startDaemon(id)), env);
  daemons.push(daemon);
  return { daemon, env };
}

/** Attach as a client of an already-running daemon. */
async function attach(id: string, env: NodeJS.ProcessEnv, client = "ui") {
  const connected = await connect(id, env, { client, autostart: false });
  clients.push(connected);
  return connected;
}

/** Test-only low-level fixture: the daemon owns creation; the client only projects it. */
async function projectAgent(
  daemon: SessionDaemonService,
  client: SessionClientShape,
  options: Omit<SessionOptions, "backend">,
) {
  const id = options.id ?? `transport-${nextProjection++}`;
  const live = await Effect.runPromise(daemon.liveSessions());
  (client.live as Set<string>).add(id);
  const projected = new Session({ ...options, id, backend: client.backend() });
  agents.push(projected);
  if (!live.includes(id)) {
    await Effect.runPromise(
      daemon.spawnSession({
        kind: options.kind,
        id,
        cmd: options.cmd,
        cwd: options.cwd,
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
      }),
    );
  }
  return projected;
}

function modeledAgent(client: SessionClientShape): {
  id: string;
  cmd: string[];
  cwd?: string;
  cols: number;
  rows: number;
} {
  const agent = client
    .workspace()
    .spaces[0]?.windows[0]?.agents.find((candidate) => !candidate.exited);
  if (!agent) throw new Error("no modeled live agent");
  return agent;
}

/** Wait for a predicate, so tests assert on outcomes rather than on sleeps. */
async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** What the agent's terminal is actually showing, as text. The app's own
 *  capture path, so these assertions read the screen the user would. */
const screen = (agent: Session) => captureVisible(agent.term);

test("an agent's bytes travel to the daemon and its output comes back", async () => {
  const { daemon, env } = await session("roundtrip");
  const client = await attach("roundtrip", env);

  const agent = await projectAgent(daemon, client, { cmd: ["cat"] });

  // The spawn is a round trip over RPC, so the first write has to be held until
  // the daemon actually has an agent by this name to give it to.
  agent.write("hello-from-the-client\n");
  await until(() => screen(agent).includes("hello-from-the-client"), "cat to echo the input");

  // And the daemon, not this process, is the one holding the PTY.
  expect(await Effect.runPromise(daemon.liveSessions())).toContain(agent.id);
});

test("native agent status frames become authoritative projected state", async () => {
  const { daemon, env } = await session("native-status");
  const client = await attach("native-status", env);
  const cmd = [
    process.execPath,
    "-e",
    `process.stdout.write(JSON.stringify({_tag:"agent.status",session:"native-status-agent",sequence:1,state:"working"})+"\\n"); setTimeout(()=>{},30000)`,
  ];
  await Effect.runPromise(
    daemon.spawnSession({ kind: "agent", id: "native-status-agent", cmd, cols: 80, rows: 24 }),
  );
  (client.live as Set<string>).add("native-status-agent");
  const agent = new Session({
    id: "native-status-agent",
    cmd,
    kind: "agent",
    backend: client.backend(),
  });
  agents.push(agent);

  await until(() => agent.state === "working", "native working status");
  expect(agent.state).toBe("working");
  await Effect.runPromise(daemon.killSession(agent.id));
});

test("two clients share output and input, and one can leave without detaching the other", async () => {
  const { daemon, env } = await session("shared-attach");
  const first = await attach("shared-attach", env, "first");
  const second = await attach("shared-attach", env, "second");

  const firstAgent = await projectAgent(daemon, first, { cmd: ["cat"] });
  const secondAgent = await projectAgent(daemon, second, { id: firstAgent.id, cmd: ["cat"] });

  firstAgent.write("first-input\n");
  await until(
    () => screen(firstAgent).includes("first-input") && screen(secondAgent).includes("first-input"),
    "both clients to see first input",
  );
  secondAgent.write("second-input\n");
  await until(
    () =>
      screen(firstAgent).includes("second-input") && screen(secondAgent).includes("second-input"),
    "both clients to see second input",
  );

  // The second adoption is targeted replay, not a broadcast: it receives the
  // existing screen while the first client's view remains live and unchanged.
  expect(screen(secondAgent)).toContain("first-input");
  first.close();
  // Wait for the daemon to actually PROCESS the EOF, not merely for `attached`
  // to be true — it was already true before the close, so waiting on it would
  // return instantly and prove nothing about the release path.
  await until(
    async () => (await attachedClients(daemon)).length === 1,
    "the daemon to notice the first client leave",
  );
  expect(await attachedClients(daemon)).toEqual(["second"]);

  secondAgent.write("still-shared\n");
  await until(
    () => screen(secondAgent).includes("still-shared"),
    "the remaining client to keep working",
  );
  expect(
    (
      await run(
        controlCall(daemon.id, (c) => c.Ping()),
        env,
      )
    ).attached,
  ).toBe(true);
});

test("an agent outlives the client, and the next client adopts it", async () => {
  const { daemon, env } = await session("outlives");
  const first = await attach("outlives", env);

  const agent = await projectAgent(daemon, first, { cmd: ["cat"] });
  let exited = false;
  agent.onExit = () => {
    exited = true;
  };
  agent.write("first-life\n");
  await until(() => screen(agent).includes("first-life"), "the first client's echo");

  // Detach, exactly as closing the terminal would.
  first.close();
  await until(
    async () => (await attachedClient(daemon)) === null,
    "the daemon to notice the detach",
  );
  expect(await Effect.runPromise(daemon.liveSessions())).toContain(agent.id);

  // The backend closed with no exit code: the attachment ended, the process
  // did not. Reporting 0 here would be a lie the sidebar renders as "done".
  await until(() => agent.detached, "the detached backend to close");
  expect(agent.exited).toBe(false);
  expect(exited).toBe(false);
  expect(agent.exitCode).toBeNull();
  expect(agent.detached).toBe(true);
  expect(agent.state).toBe("detached");

  const second = await attach("outlives", env);
  expect(second.live).toContain(agent.id);

  // Adopted under the same id: nothing was re-run, so the same `cat` is still
  // there to answer. A fresh spawn would also echo, which is why the assertion
  // below is about the daemon's agent list and not just about the echo.
  const readopted = await projectAgent(daemon, second, { id: agent.id, cmd: ["cat"] });
  readopted.write("second-life\n");
  await until(() => screen(readopted).includes("second-life"), "the adopted agent's echo");
  expect(
    (await Effect.runPromise(daemon.liveSessions())).filter((id) => id === agent.id),
  ).toHaveLength(1);
});

test("a process that ends reports its exit code through the stream", async () => {
  const { daemon, env } = await session("exits");
  const client = await attach("exits", env);

  const agent = await projectAgent(daemon, client, { cmd: ["sh", "-c", "exit 7"] });

  await until(() => agent.exited, "the agent to exit");
  expect(agent.detached).toBe(false);
  expect(agent.state).toBe("done");
  expect(agent.exitCode).toBe(7);
});

/**
 * A stand-in for an agent CLI: a copy of bash under an agent's name, so a test
 * can run it and detection can read its argv from /proc.
 *
 * A copy rather than a wrapper script, because detection reads the foreground
 * process's argv — a script that `exec`s bash leaves nothing behind with the
 * agent's name on it, which is exactly the right answer for a wrapper and the
 * wrong shape for a fixture.
 */
async function fakeAgent(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "amux-daemon-agent-"));
  dirs.push(dir);
  const path = join(dir, name);
  const bash = which("bash");
  if (!bash) throw new Error("no bash on PATH to impersonate");
  await Bun.write(path, Bun.file(bash));
  await chmod(path, 0o755);
  return path;
}

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
test("an agent started from a shell is detected through the daemon backend", async () => {
  const { daemon, env } = await session("foreground-detection");
  const client = await attach("foreground-detection", env);

  const claude = await fakeAgent("claude");
  const agent = await projectAgent(daemon, client, {
    name: "shell",
    cmd: ["bash", "--norc", "--noprofile"],
  });

  // A fresh shell at a prompt has no foreground command to name: its pgid is
  // its own session id, and detection must not mistake the shell for an agent.
  await until(() => agent.foregroundCommand === "", "the shell at a prompt to report no command");
  expect(agent.agentKind).toBe(null);

  agent.write(`${claude} --norc --noprofile\n`);
  await until(() => agent.agentKind === "claude", "the foreground agent to be detected");
  expect(agent.foregroundCommand).toBe("claude");
  // The visible consequence of the fix: the agents-only filter would keep this
  // pane now.
  expect(agent.agentKind).toBe("claude");
});

/**
 * The other half of ts-572660: the daemon exists so a session outlives its
 * client, so detection must survive a reconnect too. A session that was
 * running an agent before the UI died is quiescent afterwards — nothing
 * changes, so a change-only poller would never wake the readopted client. The
 * daemon's sync reply to an adoption is the only thing that can carry the
 * current foreground, and it must.
 */
test("a reattaching client detects an agent already in the foreground", async () => {
  const { daemon, env } = await session("foreground-adopt");
  const first = await attach("foreground-adopt", env, "first");

  const claude = await fakeAgent("claude");
  const agent = await projectAgent(daemon, first, {
    name: "shell",
    cmd: ["bash", "--norc", "--noprofile"],
  });
  await until(() => agent.foregroundCommand === "", "the shell at a prompt to report no command");
  agent.write(`${claude} --norc --noprofile\n`);
  await until(() => agent.agentKind === "claude", "the foreground agent to be detected");

  first.close();
  await until(
    async () => (await attachedClient(daemon)) === null,
    "the daemon to notice the detach",
  );

  const second = await attach("foreground-adopt", env, "second");
  const readopted = await projectAgent(daemon, second, {
    id: agent.id,
    cmd: ["bash", "--norc", "--noprofile"],
  });

  // Nothing changes on this session after adoption — no keystroke, no output,
  // no foreground switch. The daemon's sync reply must carry the answer.
  await until(() => readopted.agentKind === "claude", "the adopted agent to be detected");
  expect(readopted.foregroundCommand).toBe("claude");
});

test("output written immediately before exit arrives before the exit frame", async () => {
  const { daemon, env } = await session("drain-order");
  const client = await attach("drain-order", env);

  const agent = await projectAgent(daemon, client, {
    cmd: ["sh", "-c", "printf 'last-bytes\\n'; exit 9"],
  });

  await until(() => agent.exited, "the short-lived agent to exit");
  expect(screen(agent).replace(/\s/g, "")).toContain("last-bytes");
  expect(agent.exitCode).toBe(9);
});

test("an exited session queue is reclaimed only after its exit is consumed", async () => {
  const { daemon } = await session("reclaim-queue");
  const client = await AttachClient.connect({ path: daemon.paths.attach, client: "queue-test" });

  const firstFrames: string[] = [];
  const firstDone = Effect.runPromise(
    Stream.runForEach(client.stream("agent-1"), (frame) =>
      Effect.sync(() => firstFrames.push(frame._tag)),
    ),
  );
  const first = await Effect.runPromise(
    daemon.spawnSession({
      id: "agent-1",
      cmd: ["sh", "-c", "printf first; exit 3"],
      cols: 80,
      rows: 24,
    }),
  );
  await Effect.runPromise(first.exit);
  await Promise.race([
    firstDone,
    Bun.sleep(2_000).then(() => {
      throw new Error("the session stream did not finish after its exit");
    }),
  ]);
  expect(firstFrames.at(-1)).toBe("exit");

  // A foreground frame can now lead a session's frames (the daemon reports the
  // shell's pgid as soon as it owns the tty), so "the first frame is output"
  // is not a contract any more — collect through the exit instead.
  const secondDone = Effect.runPromise(
    Stream.runCollect(
      client.stream("agent-1").pipe(Stream.takeUntil((frame) => frame._tag === "exit")),
    ),
  );
  const second = await Effect.runPromise(
    daemon.spawnSession({
      id: "agent-1",
      cmd: ["sh", "-c", "printf second; exit 4"],
      cols: 80,
      rows: 24,
    }),
  );
  await Effect.runPromise(second.exit);
  const frames = await Promise.race([
    secondDone,
    Bun.sleep(2_000).then(() => {
      throw new Error("the replacement session did not receive output");
    }),
  ]);
  expect(
    [...frames].some(
      (frame) => frame._tag === "output" && Buffer.from(frame.data).toString().includes("second"),
    ),
  ).toBe(true);
  client.close();
});

test("an unconsumed exit cannot poison a same-id replacement session", async () => {
  const { daemon } = await session("reclaim-unconsumed");
  const client = await AttachClient.connect({
    path: daemon.paths.attach,
    client: "unconsumed-test",
  });

  const first = await Effect.runPromise(
    daemon.spawnSession({
      id: "agent-1",
      cmd: ["sh", "-c", "printf first; exit 3"],
      cols: 80,
      rows: 24,
    }),
  );
  await Effect.runPromise(first.exit);
  // The PTY exit and its daemon publication are separate events. Let the
  // unconsumed terminal frame reach the client before opening the replacement.
  await Bun.sleep(50);

  const replacement = Effect.runPromise(
    Stream.runCollect(
      client.stream("agent-1").pipe(Stream.takeUntil((frame) => frame._tag === "exit")),
    ),
  );
  const second = await Effect.runPromise(
    daemon.spawnSession({
      id: "agent-1",
      cmd: ["sh", "-c", "printf second; exit 4"],
      cols: 80,
      rows: 24,
    }),
  );
  await Effect.runPromise(second.exit);
  const frames = await Promise.race([
    replacement,
    Bun.sleep(2_000).then(() => {
      throw new Error("the replacement session did not finish");
    }),
  ]);

  expect([...frames].at(-1)?._tag).toBe("exit");
  expect([...frames].every((frame) => frame._tag !== "exit" || frame.code === 4)).toBe(true);
  expect(
    [...frames].some(
      (frame) => frame._tag === "output" && Buffer.from(frame.data).toString().includes("second"),
    ),
  ).toBe(true);
  client.close();
});

test("rotates generations at exit without losing ordered frames in one chunk", async () => {
  const home = await mkdtemp(join(tmpdir(), "amux-generations-"));
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
  const client = await AttachClient.connect({ path, client: "generation-test" });

  const firstDone = Effect.runPromise(Stream.runCollect(client.stream("agent-1")));
  await Bun.sleep(0);
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
  const firstFrames = [...(await firstDone)];
  expect(firstFrames.map((frame) => frame._tag)).toEqual(["output", "exit"]);
  expect(firstFrames.at(-1)?._tag).toBe("exit");

  const replacementDone = Effect.runPromise(
    Stream.runCollect(client.stream("agent-1").pipe(Stream.take(2))),
  );
  await Bun.sleep(0);
  peer!.write(encodeAttachFrame({ _tag: "exit", session: "agent-1", code: 4 }));
  const replacementFrames = [...(await replacementDone)];
  const replacementOutput = replacementFrames[0];
  expect(replacementOutput?._tag).toBe("output");
  if (replacementOutput?._tag === "output")
    expect(Buffer.from(replacementOutput.data).toString()).toBe("replacement");
  expect(replacementFrames.at(-1)?._tag).toBe("exit");

  client.close();
  listener.stop(true);
});

test("an unacquired stream does not retain a terminal generation", async () => {
  const home = await mkdtemp(join(tmpdir(), "amux-unacquired-"));
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
  const client = await AttachClient.connect({ path, client: "unacquired-test" });
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
  await expect(client.ping(1_000)).resolves.toBe(true);
  void unused;
  const replacement = Effect.runPromise(
    Stream.runCollect(client.stream("agent-1").pipe(Stream.take(1))),
  );
  const frames = [...(await replacement)];
  expect(frames).toHaveLength(1);
  const freshOutput = frames[0];
  expect(freshOutput?._tag).toBe("output");
  if (freshOutput?._tag === "output")
    expect(Buffer.from(freshOutput.data).toString()).toBe("fresh");

  client.close();
  listener.stop(true);
});

test("an unsubscribed session disconnects rather than silently dropping frames", async () => {
  const home = await mkdtemp(join(tmpdir(), "amux-overflow-"));
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
  const client = await AttachClient.connect({ path, client: "overflow-test" });
  peer!.write(
    Array.from({ length: 300 }, (_, index) =>
      encodeAttachFrame({
        _tag: "output",
        session: "agent-1",
        data: new TextEncoder().encode(`frame-${String(index).padStart(3, "0")}\n`),
      }),
    ).join("") + encodeAttachFrame({ _tag: "exit", session: "agent-1", code: 0 }),
  );

  await Bun.sleep(100);
  await until(() => client.closed, "the overflowing client to disconnect");
  expect(client.closed).toBe(true);
  client.close();
  listener.stop(true);
});

test("a delayed handshake closes its socket and rejects on timeout", async () => {
  const home = await mkdtemp(join(tmpdir(), "amux-handshake-timeout-"));
  dirs.push(home);
  const path = join(home, "attach.sock");
  let closed = 0;
  let latePongs = 0;
  let settlements = 0;
  let resurrected: import("./attach.ts").AttachClientShape | null = null;
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
    await expect(acquire("late-open")).rejects.toThrow("timed out");
  } finally {
    Bun.connect = originalConnect;
  }
  await until(() => closed === 1, "the socket delivered by the late open callback to close");

  await expect(acquire("late-pong")).rejects.toThrow("timed out");
  await until(() => closed === 2, "the delayed pong handshake socket to close");
  await until(() => latePongs === 1, "the late pong callback to run");
  await Bun.sleep(20);
  expect(settlements).toBe(2);
  expect(closed).toBe(2);
  expect(resurrected).toBeNull();
  listener.stop(true);
});

test("the connection scope emits heartbeats and stops them when released", async () => {
  const home = await mkdtemp(join(tmpdir(), "amux-heartbeat-"));
  dirs.push(home);
  const path = join(home, "attach.sock");
  let buffer = "";
  let beats = 0;
  let closes = 0;
  let finalized = 0;
  let client: import("./attach.ts").AttachClientShape | null = null;
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

  await Effect.runPromise(
    Effect.gen(function* () {
      client = yield* AttachClient;
      client.onClose = () => {
        finalized += 1;
      };
      yield* Effect.promise(() => until(() => beats >= 2, "the client heartbeat", 1_000));
    }).pipe(
      Effect.provide(AttachClient.layer({ path, client: "heartbeat", pingSeconds: 0.02 })),
      Effect.scoped,
    ),
  );

  await until(() => closes === 1, "the scoped attachment to close");
  const releasedAt = beats;
  await Bun.sleep(80);
  expect(beats).toBe(releasedAt);
  expect(finalized).toBe(1);
  client!.close();
  expect(finalized).toBe(1);
  listener.stop(true);
});

test("a handshake error closes the transport without leaving a client", async () => {
  const home = await mkdtemp(join(tmpdir(), "amux-handshake-error-"));
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

  await expect(
    AttachClient.connect({ path, client: "rejected", helloTimeoutMs: 100 }),
  ).rejects.toThrow("daemon closed");
  await until(() => closed === 1, "the rejected handshake socket to close");
  listener.stop(true);
});

test("killing through the daemon ends the agent here too", async () => {
  const { daemon, env } = await session("killed");
  const client = await attach("killed", env);

  const saved = modeledAgent(client);
  const agent = new Session({ ...saved, backend: client.backend() });
  agents.push(agent);

  let live: readonly string[] = [];
  await until(() => {
    void Effect.runPromise(daemon.liveSessions()).then((ids) => (live = ids));
    return live.includes(agent.id);
  }, "the daemon to have the agent");

  await run(
    client.runWorkspace(command("session.kill", { session: agent.id }), {
      size: { cols: 80, rows: 24 },
      shell: ["sh"],
      cwd: "/tmp",
    }),
    env,
  );
  await until(() => agent.exited, "the killed agent to close");
});

test("a command that does not exist fails in the daemon and is visible here", async () => {
  const { daemon, env } = await session("missing-command");
  const client = await attach("missing-command", env);

  // The daemon spawns this happily — a PTY for a program that is not there is
  // still a PTY. The failure arrives as output and an exit, like any other
  // process that could not do its job, which is what a terminal should show.
  const agent = await projectAgent(daemon, client, { cmd: ["/definitely/not/a/program"] });

  await until(() => agent.exited, "the failed command to exit");
  expect(screen(agent)).toContain("No such file or directory");
  expect(agent.exitCode).toBeGreaterThan(0);
});

test("a projection of an unmodeled id never asks the daemon to spawn it", async () => {
  const { daemon, env } = await session("unreachable");
  const client = await attach("unreachable", env);

  const before = await Effect.runPromise(daemon.liveSessions());
  const agent = new Session({ id: "not-modeled", cmd: ["cat"], backend: client.backend() });
  agents.push(agent);

  await until(() => agent.exited, "the invalid projection to close");
  expect(screen(agent)).toContain("is not live");
  expect(await Effect.runPromise(daemon.liveSessions())).toEqual(before);
});

test("a client whose daemon stops sees a detach, not a process exit", async () => {
  const { daemon, env } = await session("daemon-dies");
  const client = await attach("daemon-dies", env);

  const agent = await projectAgent(daemon, client, { cmd: ["cat"] });
  agent.write("before-death\n");
  await until(() => screen(agent).includes("before-death"), "the client's echo");

  // Explicit stop ends the daemon, its socket and its agents in one move. No
  // exit frame is in flight, so the client learns about it the same way it
  // would learn about a crash — as an attachment ending, never as a clean
  // exit. A stop and a crash only diverge on the next RPC: stop removed the
  // session, a crash left it restorable.
  await Effect.runPromise(daemon.stop);
  daemons.splice(daemons.indexOf(daemon), 1);

  await until(() => agent.detached, "the client to notice the daemon went away");
  expect(agent.exited).toBe(false);
  expect(agent.exitCode).toBeNull();
  expect(agent.state).toBe("detached");
  expect(snapshotSessionEntry(agent).exited).toBe(false);
});

test("a reattaching client sees an adopted agent's screen without it redrawing", async () => {
  const { daemon, env } = await session("replay-screen");
  const first = await attach("replay-screen", env);

  const agent = await projectAgent(daemon, first, { cmd: ["cat"] });
  agent.write("left-on-screen\n");
  await until(() => screen(agent).includes("left-on-screen"), "the first client's echo");

  first.close();
  await until(
    async () => (await attachedClient(daemon)) === null,
    "the daemon to notice the detach",
  );

  const second = await attach("replay-screen", env);
  const readopted = await projectAgent(daemon, second, { id: agent.id, cmd: ["cat"] });

  // cat never redraws. The old line can reach this fresh pane only through the
  // daemon's replay; without it the pane stays blank until some later echo.
  await until(() => screen(readopted).includes("left-on-screen"), "the replayed screen");
  expect(await Effect.runPromise(daemon.liveSessions())).toContain(agent.id);
});

test("an adopted agent is resized before its screen replay", async () => {
  const { daemon, env } = await session("replay-resize");
  const first = await attach("replay-resize", env, "first");
  const agent = await projectAgent(daemon, first, { cmd: ["cat"], cols: 80, rows: 24 });
  agent.write("resized-replay\n");
  await until(() => screen(agent).includes("resized-replay"), "the first client's echo");

  first.close();
  await until(
    async () => (await attachedClient(daemon)) === null,
    "the daemon to notice the detach",
  );

  const second = await attach("replay-resize", env, "second");
  const readopted = await projectAgent(daemon, second, {
    id: agent.id,
    cmd: ["cat"],
    cols: 40,
    rows: 10,
  });

  await until(() => screen(readopted).includes("resized-replay"), "the resized replay");
  expect(readopted.term.cols).toBe(40);
  expect(readopted.term.rows).toBe(10);
});

test("daemon replay keeps only the current screen, with no scrollback", async () => {
  const { daemon, env } = await session("replay-no-scrollback");
  const first = await attach("replay-no-scrollback", env, "first");
  const agent = await projectAgent(daemon, first, {
    cmd: [
      "sh",
      "-c",
      "printf 'old-1\\nold-2\\nold-3\\nold-4\\nold-5\\nold-6\\nold-7\\nold-8\\nold-9\\nold-10\\nlast\\n'; sleep 30",
    ],
    cols: 40,
    rows: 4,
  });
  await until(
    () => screen(agent).includes("last"),
    "the daemon terminal to receive the final line",
  );
  expect(screen(agent)).not.toContain("old-3");

  first.close();
  await until(
    async () => (await attachedClient(daemon)) === null,
    "the daemon to notice the detach",
  );
  const second = await attach("replay-no-scrollback", env, "second");
  const readopted = await projectAgent(daemon, second, {
    id: agent.id,
    cmd: ["cat"],
    cols: 40,
    rows: 4,
  });

  await until(() => screen(readopted).includes("last"), "the current screen replay");
  expect(screen(readopted)).not.toContain("old-3");
});

test("an alternate-screen app's view is replayed intact to a reattaching client", async () => {
  const { daemon, env } = await session("replay-alt");
  const first = await attach("replay-alt", env);

  const cmd = ["sh", "-c", "printf '\\033[?1049h\\033[2J\\033[2;2Halt-mode-view'; sleep 30"];
  const agent = await projectAgent(daemon, first, { cmd });
  await until(
    () => screen(agent).includes("alt-mode-view"),
    "the app to draw its alternate screen",
  );
  expect(agent.term.mode(MODE_ALT_SCREEN)).toBe(true);

  first.close();
  await until(
    async () => (await attachedClient(daemon)) === null,
    "the daemon to notice the detach",
  );

  const second = await attach("replay-alt", env);
  const readopted = await projectAgent(daemon, second, { id: agent.id, cmd });

  // The content alone could have landed on the wrong screen; the mode check is
  // the discriminator. A raw byte-suffix replay would fail exactly here.
  await until(() => screen(readopted).includes("alt-mode-view"), "the replayed alternate screen");
  expect(readopted.term.mode(MODE_ALT_SCREEN)).toBe(true);
});

/**
 * The real deployment path: a daemon in its own process, started on demand.
 *
 * Every other test here hosts the daemon in the test process, which is the
 * right trade for exercising behaviour but leaves the one claim that matters
 * most unproven — that the agents are in a process that does not go away when
 * this one does. Here the daemon is a separate pid, and the client attaching
 * the second time is a genuine reattach.
 */
test("a daemon started on demand keeps agents between two separate clients", async () => {
  const home = await mkdtemp(join(tmpdir(), "amux-autostart-"));
  dirs.push(home);
  // A real environment, plus a private state root: the daemon has to spawn
  // programs, and a PATH-less env would fail for reasons that have nothing to
  // do with what is under test.
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state") };
  const id = "autostart";

  const first = await connect(id, env, { client: "first" });
  try {
    const lease = await run(SessionStore.readLease(id), env);
    expect(lease?.pid).toBeGreaterThan(0);
    expect(lease!.pid).not.toBe(process.pid);

    const saved = modeledAgent(first);
    const agent = new Session({ ...saved, backend: first.backend() });
    agents.push(agent);
    agent.write("printf 'across-processes\\n'\n");
    await until(() => screen(agent).includes("across-processes"), "the daemon's echo");
    first.close();

    // A second client, with no memory of the first, finds the agent still there.
    const second = await connect(id, env, { client: "second" });
    expect(second.live).toContain(agent.id);
    const readopted = new Session({ ...saved, backend: second.backend() });
    agents.push(readopted);
    readopted.write("printf 'still-alive\\n'\n");
    await until(() => screen(readopted).includes("still-alive"), "the adopted agent's echo");
    await run(second.stop(), env);
  } finally {
    const lease = await run(SessionStore.readLease(id), env);
    if (lease && processAlive(lease.pid)) process.kill(lease.pid, "SIGKILL");
  }
});

test("a daemon workspace mutation is visible to a later client", async () => {
  const { env } = await session("saved");
  const client = await attach("saved", env);

  await run(
    client.runWorkspace(command("space.rename", { name: "proj" }), {
      size: { cols: 80, rows: 24 },
      shell: ["sh"],
      cwd: "/tmp",
    }),
    env,
  );

  // And a client attaching later is handed that same workspace to rebuild from.
  client.close();
  const next = await attach("saved", env, "second");
  expect(next.workspace().spaces.map((s) => s.name)).toEqual(["proj"]);
});

test("SessionClient exposes no unrevisioned process mutation methods", async () => {
  const { env } = await session("client-authority-surface");
  const client = await attach("client-authority-surface", env);
  expect("spawn" in client).toBe(false);
  expect("kill" in client).toBe(false);
});

test("releasing a client projection closes local resources without killing the daemon PTY", async () => {
  const { daemon, env } = await session("projection-release");
  const client = await attach("projection-release", env);
  const agent = await projectAgent(daemon, client, { cmd: ["sleep", "30"] });
  await Effect.runPromise(agent.release());
  expect(await Effect.runPromise(daemon.liveSessions())).toContain(agent.id);
});

test("a failed workspace response is neither accepted nor left as a phantom PTY", async () => {
  const { daemon, env } = await session("client-transaction");
  const client = await attach("client-transaction", env);
  const before = client.workspace();
  const beforeLive = await Effect.runPromise(daemon.liveSessions());
  const p = await run(sessionPaths("client-transaction"), env);
  await rm(p.backup, { recursive: true, force: true });
  await mkdir(p.backup);

  await expect(
    run(
      client.runWorkspace(command("pane.split", { axis: "row" }), {
        size: { cols: 80, rows: 24 },
        shell: ["sh"],
        cwd: "/tmp",
      }),
      env,
    ),
  ).rejects.toThrow();
  expect(client.workspace()).toEqual(before);
  expect(await Effect.runPromise(daemon.getWorkspace)).toEqual(before);
  expect(await Effect.runPromise(daemon.liveSessions())).toEqual(beforeLive);
});

test("a natural terminal exit is published only after its workspace generation is durable", async () => {
  const { daemon, env } = await session("exit-order");
  const client = await attach("exit-order", env);
  const before = new Set(
    client
      .workspace()
      .spaces.flatMap((space) =>
        space.windows.flatMap((window) => window.agents.map((agent) => agent.id)),
      ),
  );
  const created = await run(
    client.runWorkspace(command("pane.split", { axis: "row" }), {
      size: { cols: 80, rows: 24 },
      shell: ["sh", "-c", "exit 7"],
      cwd: "/tmp",
    }),
    env,
  );
  const id = created.spaces
    .flatMap((space) => space.windows)
    .flatMap((window) => window.agents)
    .find((agent) => !before.has(agent.id))!.id;

  await Effect.runPromise(
    Stream.runForEach(client.attach.stream(id), (frame) => {
      if (frame._tag !== "exit") return Effect.void;
      return SessionStore.load("exit-order").pipe(
        Effect.provide(SessionStore.Default),
        Effect.provide(BunFileSystem.layer),
        Effect.withConfigProvider(ConfigProvider.fromJson(env)),
        Effect.map((saved) => {
          const agent = saved?.spaces
            .flatMap((space) => space.windows)
            .flatMap((window) => window.agents)
            .find((candidate) => candidate.id === id);
          expect(agent?.exited).toBe(true);
          expect(agent?.exitCode).toBe(7);
        }),
      );
    }),
  );
  await Effect.runPromise(daemon.stop);
  daemons.splice(daemons.indexOf(daemon), 1);
});

test("a transient natural-exit write failure does not consume the terminal exit latch", async () => {
  const { daemon, env } = await session("exit-retry-order");
  const client = await attach("exit-retry-order", env);
  const before = new Set(
    client
      .workspace()
      .spaces.flatMap((space) =>
        space.windows.flatMap((window) => window.agents.map((agent) => agent.id)),
      ),
  );
  const created = await run(
    client.runWorkspace(command("pane.split", { axis: "row" }), {
      size: { cols: 80, rows: 24 },
      shell: ["sh", "-c", "sleep 0.2; exit 9"],
      cwd: "/tmp",
    }),
    env,
  );
  const id = created.spaces
    .flatMap((space) => space.windows)
    .flatMap((window) => window.agents)
    .find((agent) => !before.has(agent.id))!.id;
  const p = await run(sessionPaths("exit-retry-order"), env);
  await rm(p.backup, { recursive: true, force: true });
  await mkdir(p.backup);

  let sawExit = false;
  const exit = Effect.runPromise(
    Stream.runForEach(client.attach.stream(id), (frame) => {
      if (frame._tag !== "exit") return Effect.void;
      sawExit = true;
      return SessionStore.load("exit-retry-order").pipe(
        Effect.provide(SessionStore.Default),
        Effect.provide(BunFileSystem.layer),
        Effect.withConfigProvider(ConfigProvider.fromJson(env)),
        Effect.map((saved) => {
          const agent = saved?.spaces
            .flatMap((space) => space.windows)
            .flatMap((window) => window.agents)
            .find((candidate) => candidate.id === id);
          expect(agent?.exited).toBe(true);
          expect(agent?.exitCode).toBe(9);
        }),
      );
    }),
  );
  await until(
    () =>
      run(
        controlCall(daemon.id, (c) => c.Status()),
        env,
      ).then((status) => status.degraded !== undefined),
    "the persistence failure to surface",
  );
  await rm(p.backup, { recursive: true, force: true });
  await Promise.race([
    exit,
    Bun.sleep(2_000).then(() => {
      throw new Error("exit stayed latched after recovery");
    }),
  ]);
  expect(sawExit).toBe(true);
});

test("attached clients subscribe to ordered workspace generations", async () => {
  const { env } = await session("model-subscription");
  const first = await attach("model-subscription", env, "first");
  const second = await attach("model-subscription", env, "second");
  const update = Effect.runPromise(Stream.runHead(second.models));

  const changed = await run(
    first.runWorkspace(command("space.rename", { name: "shared" }), {
      size: { cols: 80, rows: 24 },
      shell: ["sh"],
      cwd: "/tmp",
    }),
    env,
  );
  const received = await update;

  expect(Option.isSome(received)).toBe(true);
  if (Option.isSome(received)) {
    expect(received.value.revision).toBe(changed.revision);
    expect(received.value.spaces[0]!.name).toBe("shared");
  }
});
