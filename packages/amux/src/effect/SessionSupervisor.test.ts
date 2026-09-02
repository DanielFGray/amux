import { testEffect } from "../test-effect.ts";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { AttachHub } from "./AttachHub.ts";
import { SESSION_STATE_TOPIC, type AttachFrame } from "./AttachProtocol.ts";
import { AgentLog, AgentLogDefault, makeAgentLog } from "./AgentLog.ts";
import { ProcessState } from "../process-state.ts";
import { SessionSupervisor } from "./SessionSupervisor.ts";
import { BunFileSystem } from "@effect/platform-bun";

/**
 * Frames up to and including the session's exit.
 *
 * Taking a fixed count would encode an assumption the PTY does not owe us: how
 * many reads a given burst of output arrives in. A terminal echoes typed input
 * as its own chunk, and a write can be split at any boundary, so the only
 * reliable stopping point is the exit frame.
 */
const untilExit = (frames: Stream.Stream<AttachFrame>) =>
  Stream.runCollect(Stream.takeUntil(frames, (frame) => frame._tag === "exit"));

const output = (frames: readonly AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => new TextDecoder().decode(frame.data))
    .join("");

testEffect("SessionSupervisor publishes owned PTY output and exit frames", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    yield* supervisor.spawn({
      id: "supervised-agent",
      cmd: ["bash", "-c", "printf 'hello\\n'; exit 7"],
      cols: 80,
      rows: 24,
    });
    const frames = yield* untilExit(subscription.frames);

    expect(output(frames)).toContain("hello");
    // Exit is last, always: a client that trusts frame order must never be told
    // a session is gone while output for it is still in flight. The foreground
    // frame is a side channel about the same session, not terminal content.
    expect(frames.at(-1)).toEqual({
      _tag: "exit",
      session: "supervised-agent",
      code: 7,
    });
    expect(
      frames
        .filter((frame) => frame._tag !== "foreground")
        .slice(0, -1)
        .every((frame) => frame._tag === "output"),
    ).toBe(true);
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);

/**
 * A foreign agent reports its state over the control socket instead of emitting
 * frames, and that report has to become the same durable event our own harness
 * writes. If it were only published live, a watcher resuming from a cursor —
 * or a pane remounting — would see an agent stuck in whatever state it held
 * when the client last looked.
 */
testEffect("a self-reported state is committed to the session log, not only published", () =>
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor;
    const log = yield* AgentLog;
    yield* supervisor.spawn({
      id: "foreign-agent",
      cmd: ["sh", "-c", "sleep 30"],
      cols: 80,
      rows: 24,
    });
    yield* supervisor.report("foreign-agent", SESSION_STATE_TOPIC, ProcessState.Running);
    yield* supervisor.report("foreign-agent", SESSION_STATE_TOPIC, ProcessState.Blocked);
    // A report for a session nobody is running has nowhere to land. It must not
    // fail the reporter: the hook lives inside somebody else's agent.
    yield* supervisor.report("no-such-pane", SESSION_STATE_TOPIC, ProcessState.Running);
    yield* supervisor.kill("foreign-agent");

    const events = yield* log.read("foreign-agent");
    expect(events.map((event) => event._tag === "topic" && event.payload)).toEqual([
      ProcessState.Running,
      ProcessState.Blocked,
    ]);
    // Sequenced like any other event, which is what a replay cursor reads.
    expect(events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(yield* log.read("no-such-pane")).toHaveLength(0);
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);

/**
 * `report` is the one door both `process.state` and an arbitrary plugin topic
 * publish through. The supervisor never inspects a payload's meaning — a
 * structured object commits and replays exactly like the string
 * `SESSION_STATE_TOPIC` uses, under whatever topic name the caller chose.
 */
testEffect("a report under a plugin-owned topic commits and replays as an opaque payload", () =>
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor;
    const log = yield* AgentLog;
    yield* supervisor.spawn({
      id: "foreign-agent",
      cmd: ["sh", "-c", "sleep 30"],
      cols: 80,
      rows: 24,
    });
    yield* supervisor.report("foreign-agent", "amux.agent-awareness/identity-state", {
      agent: "opencode",
      state: "working",
    });
    yield* supervisor.kill("foreign-agent");

    const events = yield* log.read("foreign-agent");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      _tag: "topic",
      session: "foreign-agent",
      sequence: 0,
      topic: "amux.agent-awareness/identity-state",
      payload: { agent: "opencode", state: "working" },
    });
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);

testEffect("a file-backed agent log survives rebuilding the supervisor", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "amux-agent-log-" });
    const log = yield* makeAgentLog(root);
    yield* Effect.gen(function* () {
      const supervisor = yield* SessionSupervisor;
      const event = {
        _tag: "agent.emit",
        event: {
          _tag: "agent.message",
          session: "persisted-agent",
          event: { _tag: "turn.start", turn: "t1", prompt: "persist" },
        },
      };
      const command = [
        process.execPath,
        "-e",
        // Escaping a child process's `-e` script source, not decoding domain data.
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")}); setTimeout(()=>{},30000)`,
      ];
      yield* supervisor.spawn({
        kind: "component",
        id: "persisted-agent",
        cmd: command,
        cols: 80,
        rows: 24,
      });
      yield* Effect.sleep("1 second");
      yield* supervisor.kill("persisted-agent");
    }).pipe(
      Effect.provide(
        SessionSupervisor.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(Layer.succeed(AgentLog, log), AttachHub.layer)),
        ),
      ),
    );
    expect(yield* log.read("persisted-agent")).toHaveLength(1);
    const rebuilt = yield* makeAgentLog(root);
    expect(yield* rebuilt.read("persisted-agent")).toHaveLength(1);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("sync replays a pending component transcript before respawn", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const log = yield* AgentLog;
    const supervisor = yield* SessionSupervisor;
    yield* log.append({
      _tag: "agent.message",
      session: "pending-agent",
      event: { _tag: "turn.start", turn: "turn-1", prompt: "hello" },
    });
    yield* log.append({
      _tag: "agent.message",
      session: "pending-agent",
      event: { _tag: "turn.end", turn: "turn-1", outcome: "completed", text: "world" },
    });

    const replay = Stream.runCollect(Stream.take(subscription.frames, 2));
    yield* supervisor.sync("client", "", "pending-agent");
    const frames = yield* replay;

    // Replayed in the order the daemon committed them, with the payloads it
    // never read carried through untouched.
    expect(frames.map((frame) => (frame as { sequence: number }).sequence)).toEqual([0, 1]);
    expect(frames.map((frame) => (frame as { event: { _tag: string } }).event._tag)).toEqual([
      "turn.start",
      "turn.end",
    ]);
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);

/**
 * The daemon is the only process that can ask a session's tty what is in the
 * foreground (tcgetpgrp goes through the master it owns), so the supervisor is
 * where the answer has to come from. A shell at a prompt reports its own pid
 * as the foreground group; running a command changes it — and the change has
 * to travel over the hub for the client's detection to ever see it.
 */
testEffect("a supervised session publishes its foreground process, and its changes", () =>
  Effect.gen(function* () {
    type FgFrame = Extract<AttachFrame, { _tag: "foreground" }>;
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    yield* supervisor.spawn({
      id: "foreground-agent",
      cmd: ["bash", "--norc", "--noprofile"],
      cols: 80,
      rows: 24,
    });
    // A shell at a prompt reports its own pid as the foreground group; a
    // command running in the foreground is a different pgid. Wait for both
    // states on the published stream.
    const atPrompt = yield* Deferred.make<FgFrame>();
    const running = yield* Deferred.make<FgFrame>();
    const waiter = yield* Effect.forkChild(
      Stream.runForEach(subscription.frames, (frame) =>
        frame._tag === "foreground"
          ? Effect.gen(function* () {
              if (frame.pgid > 0 && frame.pgid === frame.sid)
                yield* Deferred.succeed(atPrompt, frame).pipe(Effect.ignore);
              if (frame.pgid > 0 && frame.pgid !== frame.sid)
                yield* Deferred.succeed(running, frame).pipe(Effect.ignore);
            })
          : Effect.void,
      ),
    );
    // The shell has to come up and make itself the foreground group before
    // the first meaningful frame can arrive.
    yield* Deferred.await(atPrompt).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => {
        throw new Error("no foreground frame with a shell at a prompt arrived");
      }),
    );
    yield* supervisor.handle({
      _tag: "input",
      session: "foreground-agent",
      data: new TextEncoder().encode("sleep 30\n"),
    });
    yield* Deferred.await(running).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => {
        throw new Error("no foreground frame with a command running arrived");
      }),
    );
    yield* Fiber.interrupt(waiter);
    // Left running: scope teardown below has to kill it on its own.
    const fg = {
      prompt: yield* Deferred.await(atPrompt),
      running: yield* Deferred.await(running),
    };

    expect(fg.prompt.session).toBe("foreground-agent");
    expect(fg.prompt.pgid).toBe(fg.prompt.sid);
    // sleep is a real foreground process, in its own process group: the pgid it
    // reports must not be the shell's.
    expect(fg.running.pgid).toBeGreaterThan(0);
    expect(fg.running.pgid).not.toBe(fg.running.sid);
    expect(fg.running.argv[0]).toContain("sleep");
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);

/**
 * session.output is read via Stream.fromAsyncIterable, whose iterator.next()
 * call is an unabortable promise: a fiber blocked inside it cannot notice
 * interruption until the promise resolves, which for a live session only
 * happens once the backend is killed. Scope teardown must kill the backend
 * itself rather than depend on interrupting the pump to trigger that kill —
 * otherwise the pump waits on the kill and the kill waits on the pump.
 */
testEffect("scope teardown kills a session left running, without an explicit kill", () =>
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor;
    yield* supervisor.spawn({
      id: "still-running-agent",
      cmd: ["sleep", "30"],
      cols: 80,
      rows: 24,
    });
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
    Effect.timeout("5 seconds"),
    Effect.result,
    Effect.map((outcome) => {
      expect(outcome._tag).toBe("Success");
    }),
  ),
);

testEffect("SessionSupervisor routes input through the managed PTY", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    yield* supervisor.spawn({
      id: "input-agent",
      cmd: ["bash", "-c", "read line; printf 'got:%s\\n' \"$line\""],
      cols: 80,
      rows: 24,
    });
    yield* supervisor.handle({
      _tag: "input",
      session: "input-agent",
      data: new Uint8Array([104, 105, 10]),
    });
    const frames = yield* untilExit(subscription.frames);
    expect(output(frames)).toContain("got:hi");
    expect(frames.at(-1)).toEqual({
      _tag: "exit",
      session: "input-agent",
      code: 0,
    });
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);

testEffect("concurrent duplicate spawns create one child and one managed session", () =>
  Effect.gen(function* () {
    const marker = `/tmp/amux-duplicate-${randomUUID()}`;
    const frames = yield* Effect.gen(function* () {
      const hub = yield* AttachHub;
      const subscription = yield* hub.subscribe("client");
      const supervisor = yield* SessionSupervisor;
      const spec = {
        id: "duplicate-agent",
        cmd: ["bash", "-c", `printf x >> ${marker}; sleep 0.2`],
        cols: 80,
        rows: 24,
      } as const;
      const first = yield* Effect.forkChild(Effect.exit(supervisor.spawn(spec)));
      const second = yield* Effect.exit(supervisor.spawn(spec));
      const firstResult = yield* Fiber.join(first);
      expect([firstResult._tag, second._tag].sort()).toEqual(["Failure", "Success"]);
      expect(String(firstResult._tag === "Failure" ? firstResult : second)).toContain(
        "already live or starting",
      );
      expect(yield* supervisor.live).toEqual(["duplicate-agent"]);
      return yield* untilExit(subscription.frames);
    }).pipe(
      Effect.provide(
        SessionSupervisor.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
        ),
      ),
      Effect.scoped,
    );

    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readFileString(marker)).toBe("x");
    yield* fs.remove(marker, { force: true });
    expect(frames.at(-1)?._tag).toBe("exit");
  }).pipe(Effect.provide(BunFileSystem.layer)),
);

testEffect("exit cleanup releases the session and replay terminal for reuse", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    yield* supervisor.spawn({
      id: "reusable-agent",
      cmd: ["true"],
      cols: 80,
      rows: 24,
    });
    yield* untilExit(subscription.frames);
    expect(yield* supervisor.live).toEqual([]);
    yield* supervisor.spawn({
      id: "reusable-agent",
      cmd: ["true"],
      cols: 80,
      rows: 24,
    });
    expect(yield* supervisor.live).toEqual(["reusable-agent"]);
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);

testEffect("killing a trapped session publishes one exit and removes it", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    yield* supervisor.spawn({
      id: "trapped-agent",
      cmd: [
        "bash",
        "-c",
        "trap '' HUP TERM; (trap '' HUP TERM; printf CHILD_READY\\n; sleep 30) & wait",
      ],
      cols: 80,
      rows: 24,
    });
    const ready = yield* Deferred.make<void>();
    const collector = yield* Effect.forkChild(
      Stream.runCollect(
        subscription.frames.pipe(
          Stream.tap((frame) =>
            frame._tag === "output" && new TextDecoder().decode(frame.data).includes("CHILD_READY")
              ? Deferred.succeed(ready, void 0)
              : Effect.void,
          ),
          Stream.takeUntil((frame) => frame._tag === "exit"),
        ),
      ),
    );
    yield* Deferred.await(ready);
    yield* supervisor.kill("trapped-agent");
    const frames = yield* Fiber.join(collector);
    expect(yield* supervisor.live).toEqual([]);
    expect(frames.filter((frame) => frame._tag === "exit")).toHaveLength(1);
    expect(frames.at(-1)?._tag).toBe("exit");
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);

testEffect("concurrent supervisor kills publish one exit and permit same-id reuse", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    yield* supervisor.spawn({
      id: "concurrent-agent",
      cmd: ["sleep", "30"],
      cols: 80,
      rows: 24,
    });
    const received: AttachFrame[] = [];
    const exitSeen = yield* Deferred.make<void>();
    const collector = yield* Effect.forkChild(
      Stream.runForEach(subscription.frames, (frame) =>
        Effect.sync(() => received.push(frame)).pipe(
          Effect.andThen(frame._tag === "exit" ? Deferred.succeed(exitSeen, void 0) : Effect.void),
        ),
      ),
    );
    yield* Effect.all([supervisor.kill("concurrent-agent"), supervisor.kill("concurrent-agent")], {
      concurrency: "unbounded",
    });
    yield* Deferred.await(exitSeen);
    yield* Effect.sleep(50);
    yield* Fiber.interrupt(collector);
    expect(received.filter((frame) => frame._tag === "exit")).toHaveLength(1);
    expect(yield* supervisor.live).toEqual([]);
    yield* supervisor.spawn({
      id: "concurrent-agent",
      cmd: ["true"],
      cols: 80,
      rows: 24,
    });
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);

testEffect("a native agent worker is listed and killed through the supervisor", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    const agent = yield* supervisor.spawn({
      kind: "component",
      id: "worker-agent",
      cmd: [
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify({_tag:"agent.emit",event:{_tag:"topic",session:"worker-agent",topic:"session.state",payload:"working"}})+"\\n"); setTimeout(()=>{},30000)`,
      ],
      cols: 80,
      rows: 24,
    });
    expect(agent.kind).toBe("component");
    expect(yield* supervisor.live).toEqual(["worker-agent"]);
    yield* supervisor.kill("worker-agent");
    expect(yield* supervisor.live).toEqual([]);
    const frames = yield* untilExit(subscription.frames);
    expect(frames.at(-1)).toEqual({
      _tag: "exit",
      session: "worker-agent",
      code: null,
    });
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);

testEffect("a crashed native agent exits with a neutral state and a nonzero code", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    // Both axes, because this asserts on both: the substrate decides there is
    // no screen to replay, and `agent` is what makes the exit an agent's exit
    // rather than a component that merely stopped. Core only ever writes a
    // neutral ProcessState here — whether the exit was a failure is the exit
    // frame's `code`, which an agent-aware subscriber derives "failed" from.
    const spec = {
      kind: "component" as const,
      agent: "native",
      id: "crashed-worker",
      cmd: [process.execPath, "-e", "process.exit(17)"],
      cols: 80,
      rows: 24,
    };

    yield* supervisor.spawn(spec);
    const frames = yield* untilExit(subscription.frames);
    expect(frames).toContainEqual({
      _tag: "topic",
      session: "crashed-worker",
      sequence: 0,
      topic: "session.state",
      payload: "done",
    });
    expect(frames.at(-1)).toEqual({
      _tag: "exit",
      session: "crashed-worker",
      code: 17,
    });
    expect(yield* supervisor.live).toEqual([]);

    yield* supervisor.spawn({
      ...spec,
      cmd: [process.execPath, "-e", "process.exit(0)"],
    });
    expect(yield* supervisor.live).toEqual(["crashed-worker"]);
  }).pipe(
    Effect.provide(
      SessionSupervisor.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(AgentLogDefault, AttachHub.layer)),
      ),
    ),
  ),
);
