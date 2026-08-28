import { expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect, Exit, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import {
  installOpencodeHook,
  OPENCODE_PLUGIN_MARKER,
  uninstallOpencodeHook,
} from "./agent-hook.ts";
// The installed asset itself, so these assertions cover the bytes that land in
// the user's opencode rather than a TypeScript restatement of them.
import {
  AGENT_AWARENESS_IDENTITY_TOPIC,
  AmuxAgentStatePlugin,
  coreProcessState,
  STATE_BY_EVENT,
} from "./agent-hook/opencode.js";
import { isProcessState } from "./process-state.ts";
import { AGENT_AWARENESS_IDENTITY_TOPIC as PLUGIN_AGENT_AWARENESS_IDENTITY_TOPIC } from "@danielfgray/amux-agent-awareness/identity-state.ts";
import { testEffect } from "./test-effect.ts";

const scoped = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  effect.pipe(Effect.provide(BunFileSystem.layer));

/** A temporary HOME that dies with the enclosing scope. */
const temporaryHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "amux-agent-hook-" });
});

/** A stand-in for AttachHost's process-state listener that records what arrives. */
const agentStateSocket = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<{ server: Server; received: unknown[] }>((resume) => {
      const received: unknown[] = [];
      const server = createServer((socket) => {
        socket.on("data", (chunk) => {
          for (const line of chunk.toString("utf8").split("\n")) {
            if (line) received.push(JSON.parse(line));
          }
          socket.write('{"ok":true}\n');
        });
      });
      server.listen(path, () => resume(Effect.succeed({ server, received })));
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

/** Build the plugin against an environment that is restored with the scope. */
const pluginWith = (env: Record<string, string | undefined>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = { ...process.env };
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        process.env = previous;
      }),
  ).pipe(Effect.andThen(Effect.promise(() => AmuxAgentStatePlugin())));

const statusEvent = (status: string) => ({
  event: { type: "session.status", properties: { status } },
});

/* The hook is the one piece of this that cannot import the vocabulary — it
 * runs inside opencode. A `process.state` core cannot parse would be refused
 * by the socket and lost in silence, so the crossing is checked here instead:
 * every awareness state, once mapped through `coreProcessState`, must be one
 * amux's core `ProcessState` accepts. */
test("every process.state report the opencode hook can send is one amux's core accepts", () => {
  const unknown = [...STATE_BY_EVENT.values()]
    .map(coreProcessState)
    .filter((state) => !isProcessState(state));
  expect(unknown).toEqual([]);
});

/* Same crossing as above, for the topic name: the hook hardcodes this literal
 * because it cannot import the awareness plugin's schema module, so this
 * checks the two copies have not drifted apart. */
test("the hook's identity-state topic literal matches the awareness plugin's schema", () => {
  expect(AGENT_AWARENESS_IDENTITY_TOPIC).toBe(PLUGIN_AGENT_AWARENESS_IDENTITY_TOPIC);
});

testEffect("installs and uninstalls only the amux opencode plugin", () =>
  scoped(
    Effect.gen(function* () {
      const home = yield* temporaryHome;
      yield* Effect.promise(() => mkdir(join(home, ".config/opencode"), { recursive: true }));

      const path = yield* Effect.promise(() => installOpencodeHook(home));
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toContain(OPENCODE_PLUGIN_MARKER);
      expect(yield* Effect.promise(() => uninstallOpencodeHook(home))).toBe(true);
      expect(yield* Effect.promise(() => uninstallOpencodeHook(home))).toBe(false);
    }),
  ),
);

testEffect("does not remove an unrelated opencode plugin", () =>
  scoped(
    Effect.gen(function* () {
      const home = yield* temporaryHome;
      const path = join(home, ".config/opencode/plugins/amux-agent-state.js");
      yield* Effect.promise(() =>
        mkdir(join(home, ".config/opencode/plugins"), { recursive: true }),
      );
      yield* Effect.promise(() => Bun.write(path, "export default {}\n"));

      // A rejection here surfaces as a defect, not a typed failure — assert on
      // the cause so a silently-succeeding uninstall cannot pass this test.
      const exit = yield* Effect.promise(() => uninstallOpencodeHook(home)).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain("unrecognised");
      }
      expect(yield* Effect.promise(() => Bun.file(path).exists())).toBe(true);
    }),
  ),
);

testEffect("reports opencode lifecycle transitions to the agent-state socket", () =>
  scoped(
    Effect.gen(function* () {
      const home = yield* temporaryHome;
      const path = join(home, "agent-state.sock");
      const { received } = yield* agentStateSocket(path);
      const plugin = yield* pluginWith({
        AMUX_PROCESS_STATE_SOCKET: path,
        AMUX_AGENT_ID: "agent-a",
      });

      yield* Effect.promise(() => plugin.event!(statusEvent("streaming")));
      yield* Effect.promise(() => plugin.event!({ event: { type: "permission.asked" } }));
      yield* Effect.promise(() => plugin.event!({ event: { type: "session.idle" } }));

      // The two channels report each transition concurrently (Promise.all), so
      // only order within a channel is guaranteed, not interleaving between
      // them: assert each channel's own sequence independently.
      const byMethod = <M extends string>(method: M) =>
        received.filter(
          (message): message is { id: string; method: M; params: unknown } =>
            (message as { method: string }).method === method,
        );

      expect(byMethod("process.state").map((m) => m.params)).toEqual([
        { session: "agent-a", state: "running" },
        { session: "agent-a", state: "blocked" },
        { session: "agent-a", state: "idle" },
      ]);
      expect(byMethod("topic.publish").map((m) => m.params)).toEqual([
        {
          session: "agent-a",
          topic: AGENT_AWARENESS_IDENTITY_TOPIC,
          payload: { agent: "opencode", state: "working" },
        },
        {
          session: "agent-a",
          topic: AGENT_AWARENESS_IDENTITY_TOPIC,
          payload: { agent: "opencode", state: "blocked" },
        },
        {
          session: "agent-a",
          topic: AGENT_AWARENESS_IDENTITY_TOPIC,
          payload: { agent: "opencode", state: "idle" },
        },
      ]);
    }),
  ),
);

testEffect("collapses repeated states so streaming does not flood the socket", () =>
  scoped(
    Effect.gen(function* () {
      const home = yield* temporaryHome;
      const path = join(home, "agent-state.sock");
      const { received } = yield* agentStateSocket(path);
      const plugin = yield* pluginWith({
        AMUX_PROCESS_STATE_SOCKET: path,
        AMUX_AGENT_ID: "agent-a",
      });

      for (const status of ["running", "streaming", "streaming", "busy", "active"])
        yield* Effect.promise(() => plugin.event!(statusEvent(status)));

      expect(received).toHaveLength(2);
      const processState = received.find(
        (message) => (message as { method: string }).method === "process.state",
      ) as { params: { state: string } };
      const topicPublish = received.find(
        (message) => (message as { method: string }).method === "topic.publish",
      ) as { params: { payload: { state: string } } };
      expect(processState.params.state).toBe("running");
      expect(topicPublish.params.payload.state).toBe("working");
    }),
  ),
);

testEffect(
  "maps a failed turn to idle on process.state but preserves it on the identity topic",
  () =>
    scoped(
      Effect.gen(function* () {
        const home = yield* temporaryHome;
        const path = join(home, "agent-state.sock");
        const { received } = yield* agentStateSocket(path);
        const plugin = yield* pluginWith({
          AMUX_PROCESS_STATE_SOCKET: path,
          AMUX_AGENT_ID: "agent-a",
        });

        yield* Effect.promise(() => plugin.event!({ event: { type: "session.error" } }));

        const processState = received.find(
          (message) => (message as { method: string }).method === "process.state",
        ) as { params: { state: string } };
        const topicPublish = received.find(
          (message) => (message as { method: string }).method === "topic.publish",
        ) as { params: { payload: { state: string } } };
        expect(processState.params.state).toBe("idle");
        expect(topicPublish.params.payload.state).toBe("failed");
      }),
    ),
);

testEffect("contributes nothing outside an amux pane", () =>
  Effect.gen(function* () {
    const plugin = yield* pluginWith({
      AMUX_PROCESS_STATE_SOCKET: undefined,
      AMUX_AGENT_ID: undefined,
    });
    expect(plugin.event).toBeUndefined();
  }),
);

// The hook runs inside somebody else's agent: a dead or absent daemon must cost
// the agent a bounded pause, never a hang and never a thrown event handler.
test("a report to a socket nobody is listening on settles quickly", async () => {
  const previous = { ...process.env };
  process.env.AMUX_PROCESS_STATE_SOCKET = join(process.cwd(), "does-not-exist.sock");
  process.env.AMUX_AGENT_ID = "agent-a";
  try {
    const plugin = await AmuxAgentStatePlugin();
    const started = Date.now();
    await plugin.event!(statusEvent("streaming"));
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    process.env = previous;
  }
});
