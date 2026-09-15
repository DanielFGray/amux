import { expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path computation, not I/O.
import { join } from "node:path";
import { Cause, Clock, Effect, Exit, Schema as S, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { isProcessState } from "@danielfgray/amux";
import { testEffect } from "@danielfgray/amux/testing";
import { AGENT_AWARENESS_IDENTITY_TOPIC as PLUGIN_TOPIC } from "@danielfgray/amux-agent-awareness/identity-state.ts";
import {
  AGENT_AWARENESS_IDENTITY_TOPIC,
  AmuxAgentStatePlugin,
  coreProcessState,
  STATE_BY_EVENT,
} from "./assets/opencode.js";
import { claudeAdapter } from "./adapters/claude.ts";
import { codexAdapter } from "./adapters/codex.ts";
import { cursorAdapter } from "./adapters/cursor.ts";
import { opencodeAdapter } from "./adapters/opencode.ts";
import {
  MANAGED_MARKER,
  NestedHooksFileSchema,
  parseIntegrationVersion,
  SimpleHooksFileSchema,
} from "./hooks-install.ts";

const preserveExcess = { onExcessProperty: "preserve" as const };

const decodeNestedHooks = S.decodeSync(S.fromJsonString(NestedHooksFileSchema), preserveExcess);
const encodeNestedHooks = S.encodeSync(S.fromJsonString(NestedHooksFileSchema), preserveExcess);
const decodeSimpleHooks = S.decodeSync(S.fromJsonString(SimpleHooksFileSchema), preserveExcess);
const encodeSimpleHooks = S.encodeSync(S.fromJsonString(SimpleHooksFileSchema), preserveExcess);

type NestedHooksFile = typeof NestedHooksFileSchema.Type;
type SimpleHooksFile = typeof SimpleHooksFileSchema.Type;

const simpleHookCommand = (root: SimpleHooksFile, event: string, index: number): string => {
  const command = root.hooks?.[event]?.[index]?.command;
  if (command === undefined) throw new Error(`missing ${event}[${index}] command`);
  return command;
};

const simpleHookLength = (root: SimpleHooksFile, event: string): number =>
  root.hooks?.[event]?.length ?? 0;

const nestedHookCommand = (root: NestedHooksFile, event: string, index: number): string => {
  const command = root.hooks?.[event]?.[index]?.hooks?.[0]?.command;
  if (command === undefined) throw new Error(`missing ${event}[${index}] command`);
  return command;
};

const sessionStartLength = (root: NestedHooksFile): number => root.hooks?.SessionStart?.length ?? 0;

const RpcLineSchema = S.Struct({
  id: S.optionalKey(S.String),
  method: S.String,
  params: S.optionalKey(
    S.Struct({
      session: S.optionalKey(S.String),
      state: S.optionalKey(S.String),
      paneId: S.optionalKey(S.String),
      source: S.optionalKey(S.String),
      agent: S.optionalKey(S.String),
      agentSessionId: S.optionalKey(S.String),
    }),
  ),
});
const decodeRpcLine = S.decodeSync(S.fromJsonString(RpcLineSchema), preserveExcess);

const scoped = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  effect.pipe(Effect.provide(BunFileSystem.layer));

const temporaryHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "amux-continuity-" });
});

const agentStateSocket = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<{ server: Server; received: (typeof RpcLineSchema.Type)[] }>((resume) => {
      const received: (typeof RpcLineSchema.Type)[] = [];
      const server = createServer((socket) => {
        socket.on("data", (chunk) => {
          for (const line of chunk.toString("utf8").split("\n")) {
            if (line) received.push(decodeRpcLine(line));
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

const pluginWith = (env: Record<string, string | undefined>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = { ...process.env };
      for (const [key, value] of Object.entries(env)) {
        // @effect-diagnostics-next-line processEnvInEffect:off
        if (value === undefined) delete process.env[key];
        // @effect-diagnostics-next-line processEnvInEffect:off
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

test("every process.state report the opencode hook can send is one amux's core accepts", () => {
  const unknown = [...STATE_BY_EVENT.values()]
    .map(coreProcessState)
    .filter((state) => !isProcessState(state));
  expect(unknown).toEqual([]);
});

test("the hook's identity-state topic literal matches the awareness plugin's schema", () => {
  expect(AGENT_AWARENESS_IDENTITY_TOPIC).toBe(PLUGIN_TOPIC);
});

testEffect("installs and uninstalls only the amux opencode plugin", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* temporaryHome;
      yield* fs.makeDirectory(join(home, ".config/opencode"), { recursive: true });

      const path = yield* opencodeAdapter.hooks.install(home);
      expect(yield* fs.readFileString(path)).toContain(MANAGED_MARKER);
      expect(parseIntegrationVersion(yield* fs.readFileString(path))).toBe(1);
      expect(yield* opencodeAdapter.hooks.uninstall(home)).toBe(true);
      expect(yield* opencodeAdapter.hooks.uninstall(home)).toBe(false);
    }),
  ),
);

testEffect("does not remove an unrelated opencode plugin", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* temporaryHome;
      const path = join(home, ".config/opencode/plugins/amux-agent-state.js");
      yield* fs.makeDirectory(join(home, ".config/opencode/plugins"), { recursive: true });
      yield* fs.writeFileString(path, "export default {}\n");

      const exit = yield* opencodeAdapter.hooks.uninstall(home).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain("unrecognised");
      }
      expect(yield* Effect.promise(() => Bun.file(path).exists())).toBe(true);
    }),
  ),
);

testEffect("installs claude hook and leaves user SessionStart hooks alone", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* temporaryHome;
      yield* fs.makeDirectory(join(home, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        join(home, ".claude/settings.json"),
        encodeNestedHooks({
          hooks: {
            SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "prog prime" }] }],
          },
        }),
      );

      const hookPath = yield* claudeAdapter.hooks.install(home);
      const settings = decodeNestedHooks(
        yield* fs.readFileString(join(home, ".claude/settings.json")),
      );
      expect(yield* fs.readFileString(hookPath)).toContain("AMUX_INTEGRATION_ID=claude");
      expect(sessionStartLength(settings)).toBe(2);
      expect(nestedHookCommand(settings, "SessionStart", 0)).toBe("prog prime");
      expect(nestedHookCommand(settings, "SessionStart", 1)).toContain("session");

      expect(yield* claudeAdapter.hooks.uninstall(home)).toBe(true);
      const after = decodeNestedHooks(
        yield* fs.readFileString(join(home, ".claude/settings.json")),
      );
      expect(sessionStartLength(after)).toBe(1);
      expect(nestedHookCommand(after, "SessionStart", 0)).toBe("prog prime");
    }),
  ),
);

testEffect("claude install preserves unknown settings.json keys", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* temporaryHome;
      yield* fs.makeDirectory(join(home, ".claude"), { recursive: true });
      const settingsPath = join(home, ".claude/settings.json");
      yield* fs.writeFileString(
        settingsPath,
        `{
  "permissions": { "allow": ["Bash(*)"] },
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "prog prime" }] }]
  }
}
`,
      );

      yield* claudeAdapter.hooks.install(home);
      const text = yield* fs.readFileString(settingsPath);
      expect(text).toContain('"permissions"');
      expect(text).toContain("Bash(*)");
      expect(sessionStartLength(decodeNestedHooks(text))).toBe(2);
    }),
  ),
);

testEffect("installs codex hook and enables features.hooks", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* temporaryHome;
      yield* fs.makeDirectory(join(home, ".codex"), { recursive: true });
      yield* fs.writeFileString(join(home, ".codex/config.toml"), 'model = "gpt-5.4"\n');

      const hookPath = yield* codexAdapter.hooks.install(home);
      expect(yield* fs.readFileString(hookPath)).toContain("AMUX_INTEGRATION_ID=codex");
      const hooks = decodeNestedHooks(yield* fs.readFileString(join(home, ".codex/hooks.json")));
      expect(nestedHookCommand(hooks, "SessionStart", 0)).toContain("session");
      expect(yield* fs.readFileString(join(home, ".codex/config.toml"))).toContain("hooks = true");

      expect(yield* codexAdapter.hooks.uninstall(home)).toBe(true);
    }),
  ),
);

testEffect("installs cursor hook into hooks.json and leaves unrelated stop hooks", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* temporaryHome;
      yield* fs.makeDirectory(join(home, ".cursor"), { recursive: true });
      yield* fs.writeFileString(
        join(home, ".cursor/hooks.json"),
        encodeSimpleHooks({
          version: 1,
          hooks: { stop: [{ command: "echo keep-me" }] },
        }),
      );

      const hookPath = yield* cursorAdapter.hooks.install(home);
      expect(yield* fs.readFileString(hookPath)).toContain("AMUX_INTEGRATION_ID=cursor");
      const hooksFile = decodeSimpleHooks(
        yield* fs.readFileString(join(home, ".cursor/hooks.json")),
      );
      expect(simpleHookLength(hooksFile, "sessionStart")).toBe(1);
      expect(simpleHookCommand(hooksFile, "sessionStart", 0)).toContain("session");
      expect(simpleHookLength(hooksFile, "stop")).toBe(1);
      expect(simpleHookCommand(hooksFile, "stop", 0)).toBe("echo keep-me");

      yield* cursorAdapter.hooks.install(home);
      expect(
        simpleHookLength(
          decodeSimpleHooks(yield* fs.readFileString(join(home, ".cursor/hooks.json"))),
          "sessionStart",
        ),
      ).toBe(1);

      expect(yield* cursorAdapter.hooks.uninstall(home)).toBe(true);
      const after = decodeSimpleHooks(yield* fs.readFileString(join(home, ".cursor/hooks.json")));
      expect(simpleHookLength(after, "sessionStart")).toBe(0);
      expect(simpleHookCommand(after, "stop", 0)).toBe("echo keep-me");
      expect(yield* Effect.promise(() => Bun.file(hookPath).exists())).toBe(false);
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
        AMUX_PANE_ID: "pane-1",
      });

      yield* Effect.promise(() =>
        plugin.event!({
          event: {
            type: "session.status",
            properties: { status: "streaming", sessionID: "sess-1" },
          },
        }),
      );
      yield* Effect.promise(() => plugin.event!({ event: { type: "permission.asked" } }));
      yield* Effect.promise(() => plugin.event!({ event: { type: "session.idle" } }));

      const byMethod = <M extends string>(method: M) =>
        received.filter(
          (message): message is typeof message & { method: M } => message.method === method,
        );

      expect(byMethod("process.state").map((m) => m.params)).toEqual([
        { session: "agent-a", state: "running" },
        { session: "agent-a", state: "blocked" },
        { session: "agent-a", state: "idle" },
      ]);
      expect(byMethod("pane.report_agent_session")[0]?.params).toMatchObject({
        paneId: "pane-1",
        source: "amux:opencode",
        agent: "opencode",
        agentSessionId: "sess-1",
      });
    }),
  ),
);

testEffect("child session ids do not replace the root session report", () =>
  scoped(
    Effect.gen(function* () {
      const home = yield* temporaryHome;
      const path = join(home, "agent-state.sock");
      const { received } = yield* agentStateSocket(path);
      const plugin = yield* pluginWith({
        AMUX_PROCESS_STATE_SOCKET: path,
        AMUX_AGENT_ID: "agent-a",
        AMUX_PANE_ID: "pane-1",
      });

      yield* Effect.promise(() =>
        plugin.event!({
          event: {
            type: "session.updated",
            properties: { sessionID: "root", info: { id: "root" } },
          },
        }),
      );
      yield* Effect.promise(() =>
        plugin.event!({
          event: {
            type: "session.status",
            properties: {
              status: "busy",
              sessionID: "child",
              info: { id: "child", parentID: "root" },
            },
          },
        }),
      );

      const sessions = received
        .filter((m) => m.method === "pane.report_agent_session")
        .map((m) => m.params?.agentSessionId);
      expect(sessions).toEqual(["root"]);
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

testEffect("a report to a socket nobody is listening on settles quickly", () =>
  Effect.gen(function* () {
    const plugin = yield* pluginWith({
      AMUX_PROCESS_STATE_SOCKET: join(process.cwd(), "does-not-exist.sock"),
      AMUX_AGENT_ID: "agent-a",
      AMUX_PANE_ID: "pane-1",
    });
    const started = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() => plugin.event!(statusEvent("streaming")));
    expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_000);
  }),
);
