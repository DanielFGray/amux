import { testEffect } from "../test-effect.ts";
import { Chunk, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachHub } from "./AttachHub.ts";
import { type AttachFrame } from "./AttachProtocol.ts";
import { AgentLog, AgentLogDefault, makeAgentLog } from "./AgentLog.ts";
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
  Stream.runCollect(Stream.takeUntil(frames, (frame) => frame._tag === "exit")).pipe(
    Effect.map(Chunk.toReadonlyArray),
  );

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
    expect(frames.at(-1)).toEqual({ _tag: "exit", session: "supervised-agent", code: 7 });
    expect(
      frames
        .filter((frame) => frame._tag !== "foreground")
        .slice(0, -1)
        .every((frame) => frame._tag === "output"),
    ).toBe(true);
  }).pipe(
    Effect.provide(SessionSupervisor.Live),
    Effect.provide(AgentLogDefault),
    Effect.provide(AttachHub.Default),
  ),
);

testEffect("a file-backed agent log survives rebuilding the supervisor", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "amux-agent-log-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const log = yield* makeAgentLog(root);
    yield* Effect.gen(function* () {
      const supervisor = yield* SessionSupervisor;
      const event = {
        _tag: "agent.event",
        event: { _tag: "turn.start", session: "persisted-agent", turn: "t1", prompt: "persist" },
      };
      const command = [
        process.execPath,
        "-e",
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
      Effect.provide(SessionSupervisor.Live.pipe(Layer.provide(Layer.succeed(AgentLog, log)))),
      Effect.provide(AttachHub.Default),
    );
    expect(yield* log.read("persisted-agent")).toHaveLength(1);
    const rebuilt = yield* makeAgentLog(root);
    expect(yield* rebuilt.read("persisted-agent")).toHaveLength(1);
  }).pipe(Effect.provide(BunFileSystem.layer)),
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
    const waiter = yield* Effect.fork(
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
  }).pipe(
    Effect.provide(SessionSupervisor.Live),
    Effect.provide(AgentLogDefault),
    Effect.provide(AttachHub.Default),
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
    Effect.provide(SessionSupervisor.Live),
    Effect.provide(AgentLogDefault),
    Effect.provide(AttachHub.Default),
    Effect.timeout("5 seconds"),
    Effect.either,
    Effect.map((outcome) => {
      expect(outcome._tag).toBe("Right");
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
    expect(frames.at(-1)).toEqual({ _tag: "exit", session: "input-agent", code: 0 });
  }).pipe(
    Effect.provide(SessionSupervisor.Live),
    Effect.provide(AgentLogDefault),
    Effect.provide(AttachHub.Default),
  ),
);

test("concurrent duplicate spawns create one child and one managed session", async () => {
  const marker = `/tmp/amux-duplicate-${randomUUID()}`;
  const frames = await Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* AttachHub;
      const subscription = yield* hub.subscribe("client");
      const supervisor = yield* SessionSupervisor;
      const spec = {
        id: "duplicate-agent",
        cmd: ["bash", "-c", `printf x >> ${marker}; sleep 0.2`],
        cols: 80,
        rows: 24,
      } as const;
      const first = yield* Effect.fork(Effect.exit(supervisor.spawn(spec)));
      const second = yield* Effect.exit(supervisor.spawn(spec));
      const firstResult = yield* Fiber.join(first);
      expect([firstResult._tag, second._tag].sort()).toEqual(["Failure", "Success"]);
      expect(String(firstResult._tag === "Failure" ? firstResult : second)).toContain(
        "already live or starting",
      );
      expect(yield* supervisor.live).toEqual(["duplicate-agent"]);
      return yield* untilExit(subscription.frames);
    }).pipe(
      Effect.provide(SessionSupervisor.Live),
      Effect.provide(AgentLogDefault),
      Effect.provide(AttachHub.Default),
      Effect.scoped,
    ),
  );

  expect(await readFile(marker, "utf8")).toBe("x");
  await rm(marker, { force: true });
  expect(frames.at(-1)?._tag).toBe("exit");
});

testEffect("exit cleanup releases the session and replay terminal for reuse", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    yield* supervisor.spawn({ id: "reusable-agent", cmd: ["true"], cols: 80, rows: 24 });
    yield* untilExit(subscription.frames);
    expect(yield* supervisor.live).toEqual([]);
    yield* supervisor.spawn({ id: "reusable-agent", cmd: ["true"], cols: 80, rows: 24 });
    expect(yield* supervisor.live).toEqual(["reusable-agent"]);
  }).pipe(
    Effect.provide(SessionSupervisor.Live),
    Effect.provide(AgentLogDefault),
    Effect.provide(AttachHub.Default),
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
    const collector = yield* Effect.fork(
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
    const frames = Chunk.toReadonlyArray(yield* Fiber.join(collector));
    expect(yield* supervisor.live).toEqual([]);
    expect(frames.filter((frame) => frame._tag === "exit")).toHaveLength(1);
    expect(frames.at(-1)?._tag).toBe("exit");
  }).pipe(
    Effect.provide(SessionSupervisor.Live),
    Effect.provide(AgentLogDefault),
    Effect.provide(AttachHub.Default),
  ),
);

testEffect("concurrent supervisor kills publish one exit and permit same-id reuse", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    yield* supervisor.spawn({ id: "concurrent-agent", cmd: ["sleep", "30"], cols: 80, rows: 24 });
    const received: AttachFrame[] = [];
    const exitSeen = yield* Deferred.make<void>();
    const collector = yield* Effect.fork(
      Stream.runForEach(subscription.frames, (frame) =>
        Effect.sync(() => received.push(frame)).pipe(
          Effect.zipRight(frame._tag === "exit" ? Deferred.succeed(exitSeen, void 0) : Effect.void),
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
    yield* supervisor.spawn({ id: "concurrent-agent", cmd: ["true"], cols: 80, rows: 24 });
  }).pipe(
    Effect.provide(SessionSupervisor.Live),
    Effect.provide(AgentLogDefault),
    Effect.provide(AttachHub.Default),
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
        `process.stdout.write(JSON.stringify({_tag:"agent.status",session:"worker-agent",sequence:1,state:"working"})+"\\n"); setTimeout(()=>{},30000)`,
      ],
      cols: 80,
      rows: 24,
    });
    expect(agent.kind).toBe("component");
    expect(yield* supervisor.live).toEqual(["worker-agent"]);
    yield* supervisor.kill("worker-agent");
    expect(yield* supervisor.live).toEqual([]);
    const frames = yield* untilExit(subscription.frames);
    expect(frames.at(-1)).toEqual({ _tag: "exit", session: "worker-agent", code: null });
  }).pipe(
    Effect.provide(SessionSupervisor.Live),
    Effect.provide(AgentLogDefault),
    Effect.provide(AttachHub.Default),
  ),
);

testEffect("a crashed native agent reports failure and can be restarted", () =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const subscription = yield* hub.subscribe("client");
    const supervisor = yield* SessionSupervisor;
    // Both axes, because this asserts on both: the substrate decides there is
    // no screen to replay, and `agent` is what makes the exit a failed agent
    // rather than a component that merely stopped.
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
      _tag: "agent.status",
      session: "crashed-worker",
      sequence: 0,
      state: "failed",
    });
    expect(frames.at(-1)).toEqual({ _tag: "exit", session: "crashed-worker", code: 17 });
    expect(yield* supervisor.live).toEqual([]);

    yield* supervisor.spawn({ ...spec, cmd: [process.execPath, "-e", "process.exit(0)"] });
    expect(yield* supervisor.live).toEqual(["crashed-worker"]);
  }).pipe(
    Effect.provide(SessionSupervisor.Live),
    Effect.provide(AgentLogDefault),
    Effect.provide(AttachHub.Default),
  ),
);
