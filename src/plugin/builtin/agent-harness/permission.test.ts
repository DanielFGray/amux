import { expect, test } from "bun:test";
import { Effect, Fiber, Layer, Schedule } from "effect";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { agentToolkit } from "./tools.ts";
import { layer as projectStoreLayer, Service as ProjectStore } from "../../../project-store.ts";
import {
  bashResources,
  isOpaque,
  makePermissionGate,
  pathResource,
  savedRules,
  type Assertion,
} from "./permission.ts";
import { DEFAULT_RULES, type PermissionRule } from "../../../permission.ts";
import type { AgentDelta, AgentEventPayload } from "../../../effect/AttachProtocol.ts";

test("a command is split into the parts policy must clear", () => {
  expect(bashResources("ls; rm -rf ~")).toEqual(["ls", "rm -rf ~"]);
  expect(bashResources("git status && git diff | head -20")).toEqual([
    "git status",
    "git diff",
    "head -20",
  ]);
  expect(bashResources("echo 'a; b' && echo \"c|d\"")).toEqual(["echo 'a; b'", 'echo "c|d"']);
  expect(bashResources("echo a\\;b")).toEqual(["echo a\\;b"]);
  expect(bashResources("one\ntwo")).toEqual(["one", "two"]);
});

test("a command whose text is not what runs is opaque", () => {
  expect(isOpaque("echo $(whoami)")).toBe(true);
  expect(isOpaque("echo `whoami`")).toBe(true);
  expect(isOpaque("diff <(a) <(b)")).toBe(true);
  expect(isOpaque("eval $CMD")).toBe(true);
  expect(isOpaque("echo evaluate")).toBe(false);
});

test("always proposes a rule the user can read, and nothing for an opaque command", () => {
  expect(savedRules(assertion("bash", ["git status --porcelain"]))).toEqual([
    { action: "bash", resource: "git status *", effect: "allow" },
  ]);
  expect(savedRules(assertion("bash", ["ls -la src"]))).toEqual([
    { action: "bash", resource: "ls *", effect: "allow" },
  ]);
  expect(savedRules(assertion("bash", ["eval $CMD"]))).toEqual([]);
  expect(savedRules(assertion("write", ["./src/a.ts"]))).toEqual([
    { action: "write", resource: "./**", effect: "allow" },
  ]);
});

test("a project-wide file rule covers the project and nothing outside it", () => {
  expect(pathResource("/repo", "/repo/src/a.ts")).toBe("./src/a.ts");
  expect(pathResource("/repo", "/etc/passwd")).toBe("/etc/passwd");
});

test("a read runs without asking, and nothing is emitted for it", async () => {
  const world = harness();
  await Effect.runPromise(
    world.gate.pipe(Effect.flatMap((gate) => gate.assert(assertion("read", ["./a.ts"])))),
  );
  expect(world.emitted()).toEqual([]);
});

test("a write blocks until it is answered, then runs once", async () => {
  const world = harness();
  const decided = await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* world.gate;
      const running = yield* Effect.fork(gate.assert(assertion("write", ["./a.ts"])));
      const request = yield* world.awaitRequest;
      yield* gate.resolve(request, "once");
      // A second answer to a request already decided changes nothing.
      yield* gate.resolve(request, "reject", "too late");
      return yield* Fiber.join(running);
    }),
  );
  expect(decided).toBeUndefined();
  expect(world.emitted().map((frame) => frame._tag)).toEqual([
    "permission.request",
    "agent.status",
    "permission.response",
    "agent.status",
  ]);
  expect(world.emitted().find((frame) => frame._tag === "permission.response")).toMatchObject({
    decision: "once",
  });
  expect(world.saved).toEqual([]);
});

test("a rejection fails the call with the words the model is shown", async () => {
  const world = harness();
  const result = await Effect.runPromise(
    Effect.either(
      Effect.gen(function* () {
        const gate = yield* world.gate;
        const running = yield* Effect.fork(gate.assert(assertion("write", ["./a.ts"])));
        yield* gate.resolve(yield* world.awaitRequest, "reject", "not that file");
        return yield* Fiber.join(running);
      }),
    ),
  );
  expect(result).toMatchObject({ _tag: "Left", left: "Denied by the user: not that file" });
});

test("always is remembered, so the same call does not ask twice", async () => {
  const world = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* world.gate;
      const first = yield* Effect.fork(gate.assert(assertion("bash", ["git status"])));
      yield* gate.resolve(yield* world.awaitRequest, "always");
      yield* Fiber.join(first);
      yield* gate.assert(assertion("bash", ["git status --porcelain"]));
    }),
  );
  expect(world.emitted().filter((frame) => frame._tag === "permission.request")).toHaveLength(1);
  expect(world.saved).toEqual([{ action: "bash", resource: "git status *", effect: "allow" }]);
});

test("an interrupt answers the pending request instead of leaving it open", async () => {
  const world = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* world.gate;
      const running = yield* Effect.fork(gate.assert(assertion("write", ["./a.ts"])));
      yield* world.awaitRequest;
      yield* Fiber.interrupt(running);
    }),
  );
  expect(world.emitted().find((frame) => frame._tag === "permission.response")).toMatchObject({
    decision: "reject",
    feedback: "interrupted",
  });
});

test("a standing deny is refused without ever asking", async () => {
  const world = harness([{ action: "bash", resource: "rm *", effect: "deny" }]);
  const result = await Effect.runPromise(
    Effect.either(
      world.gate.pipe(Effect.flatMap((gate) => gate.assert(assertion("bash", ["rm -rf /"])))),
    ),
  );
  expect(result).toMatchObject({ _tag: "Left", left: "Denied by the user: policy denies this" });
  // The refusal is still shown: a question and its answer, in one breath.
  expect(world.emitted().map((frame) => frame._tag)).toEqual([
    "permission.request",
    "permission.response",
    "agent.status",
  ]);
});

/**
 * The whole middle at once: a real toolkit call, a real approval, a real row.
 *
 * The unit tests above split the gate from the tools and the store from both;
 * this is the path the user takes — a tool that would change a file waits, the
 * answer reaches it, the file appears, and the rule is still there for the next
 * process to read.
 */
test("an approved write runs, is remembered on disk, and does not ask again", async () => {
  const fs = await Effect.runPromise(Effect.provide(FileSystem.FileSystem, BunFileSystem.layer));
  const state = await Effect.runPromise(fs.makeTempDirectory({ prefix: "amux-gate-" }));
  const workspace = await Effect.runPromise(fs.makeTempDirectory({ prefix: "amux-work-" }));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  const frames: (AgentEventPayload | AgentDelta)[] = [];
  const store = projectStoreLayer(workspace).pipe(Layer.provide(BunFileSystem.layer));

  try {
    const written = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* makePermissionGate({
            session: "agent-1",
            turn: Effect.succeed("turn-1"),
            rules: DEFAULT_RULES,
            store: yield* ProjectStore,
            emit: (frame) => Effect.sync(() => void frames.push(frame)),
          });
          const toolkit = yield* agentToolkit(workspace, gate);
          const first = yield* Effect.fork(
            toolkit.handle("write", { path: "notes.md", content: "hello" }),
          );
          yield* gate.resolve(yield* awaitRequest(frames), "always");
          yield* Fiber.join(first);
          // The second write matches the rule the first one recorded.
          return yield* toolkit.handle("write", { path: "other.md", content: "hi" });
        }).pipe(Effect.provide(store), Effect.orDie),
      ),
    );

    expect(written.isFailure).toBe(false);
    expect(await Bun.file(`${workspace}/notes.md`).text()).toBe("hello");
    expect(await Bun.file(`${workspace}/other.md`).text()).toBe("hi");
    expect(frames.filter((frame) => frame._tag === "permission.request")).toHaveLength(1);
    // A fresh handle on the same project: the rule outlives the worker.
    const persisted = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(ProjectStore, (opened) => opened.rules).pipe(
          Effect.provide(store),
          Effect.orDie,
        ),
      ),
    );
    expect(persisted).toEqual([{ action: "write", resource: "./**", effect: "allow" }]);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    await Effect.runPromise(
      Effect.all([
        fs.remove(state, { recursive: true }),
        fs.remove(workspace, { recursive: true }),
      ]).pipe(Effect.ignore),
    );
  }
});

const assertion = (action: string, resources: readonly string[]): Assertion => ({
  action,
  resources,
  tool: action,
  input: { resources },
});

/** A gate wired to a recorded emit stream and a store that only remembers. */
function harness(extra: readonly PermissionRule[] = []) {
  const frames: (AgentEventPayload | AgentDelta)[] = [];
  const saved: PermissionRule[] = [];
  const store = {
    root: "/repo",
    rules: Effect.succeed(saved),
    addRules: (rules: readonly PermissionRule[]) => Effect.sync(() => void saved.push(...rules)),
  };
  const gate = makePermissionGate({
    session: "agent-1",
    turn: Effect.succeed("turn-1"),
    rules: [...DEFAULT_RULES, ...extra],
    store,
    emit: (frame) => Effect.sync(() => void frames.push(frame)),
  });
  return { gate, emitted: () => frames, saved, awaitRequest: awaitRequest(frames) };
}

/** The id of the request the agent is blocked on, once it has asked. */
function awaitRequest(frames: readonly (AgentEventPayload | AgentDelta)[]) {
  return Effect.suspend(() => {
    const frame = frames.findLast((candidate) => candidate._tag === "permission.request");
    return frame?._tag === "permission.request"
      ? Effect.succeed(frame.request)
      : Effect.fail("no request yet" as const);
  }).pipe(Effect.retry(Schedule.spaced("1 millis").pipe(Schedule.upTo("2 seconds"))), Effect.orDie);
}
