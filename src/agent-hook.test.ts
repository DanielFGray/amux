import { expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect, Exit, Scope } from "effect";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import {
  installOpencodeHook,
  OPENCODE_PLUGIN_MARKER,
  uninstallOpencodeHook,
} from "./agent-hook.ts";
// The installed asset itself, so these assertions cover the bytes that land in
// the user's opencode rather than a TypeScript restatement of them.
import { AmuxAgentStatePlugin, STATE_BY_EVENT } from "./agent-hook/opencode.js";
import { isReportedAgentState } from "./agent-state.ts";
import { testEffect } from "./test-effect.ts";

const scoped = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  effect.pipe(Effect.provide(BunFileSystem.layer));

/** A temporary HOME that dies with the enclosing scope. */
const temporaryHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "amux-agent-hook-" });
});

/** A stand-in for AttachHost's agent-state listener that records what arrives. */
const agentStateSocket = (path: string) =>
  Effect.acquireRelease(
    Effect.async<{ server: Server; received: unknown[] }>((resume) => {
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
      Effect.async<void>((resume) => {
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
 * runs inside opencode. A state it invents would be refused by the socket and
 * lost in silence, so the crossing is checked here instead. */
test("every state the opencode hook can send is one amux accepts", () => {
  const unknown = [...STATE_BY_EVENT.values()].filter((state) => !isReportedAgentState(state));
  expect(unknown).toEqual([]);
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

      expect(received).toEqual([
        {
          id: expect.any(String),
          method: "process.state",
          params: { session: "agent-a", state: "working" },
        },
        {
          id: expect.any(String),
          method: "process.state",
          params: { session: "agent-a", state: "blocked" },
        },
        {
          id: expect.any(String),
          method: "process.state",
          params: { session: "agent-a", state: "idle" },
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

      expect(received).toHaveLength(1);
      expect((received[0] as { params: { state: string } }).params.state).toBe("working");
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
