import { expect } from "bun:test";
import { Effect, Schema as S } from "effect";
import { isProcessPluginProtectedEnvKey, processPluginLaunchEnv } from "./env.ts";
import type { ProcessPluginManifest } from "./manifest.ts";
import { testEffect } from "../test-effect.ts";

const plugin: ProcessPluginManifest = {
  id: "example.tools",
  name: "Tools",
  version: "0.1.0",
  actions: [],
  panes: [],
  startup: [],
};

const ContextJson = S.Struct({
  spaceId: S.optionalKey(S.String),
  invocationSource: S.optionalKey(S.String),
});

testEffect("injects identity dirs and strips protected caller keys", () =>
  Effect.gen(function* () {
    const env = yield* processPluginLaunchEnv({
      plugin,
      pluginRoot: "/plugins/example.tools",
      binPath: "/usr/bin/amux",
      actionId: "hello",
      configRoot: "/cfg",
      stateRoot: "/state",
      extraEnv: {
        AMUX_PLUGIN_ID: "forged",
        PATH: "/custom/bin",
        HELLO: "world",
      },
      context: { spaceId: "s1", invocationSource: "test" },
    });
    expect(env.AMUX_ENV).toBe("1");
    expect(env.AMUX_PLUGIN_ID).toBe("example.tools");
    expect(env.AMUX_PLUGIN_ROOT).toBe("/plugins/example.tools");
    expect(env.AMUX_PLUGIN_CONFIG_DIR).toBe("/cfg/example.tools");
    expect(env.AMUX_PLUGIN_STATE_DIR).toBe("/state/example.tools");
    expect(env.AMUX_BIN_PATH).toBe("/usr/bin/amux");
    expect(env.AMUX_PLUGIN_ACTION_ID).toBe("hello");
    expect(env.PATH).toBe("/custom/bin");
    expect(env.HELLO).toBe("world");
    expect(
      yield* S.decodeEffect(S.fromJsonString(ContextJson))(env.AMUX_PLUGIN_CONTEXT_JSON!),
    ).toEqual({
      spaceId: "s1",
      invocationSource: "test",
    });
    expect(isProcessPluginProtectedEnvKey("AMUX_PLUGIN_ID")).toBe(true);
    expect(isProcessPluginProtectedEnvKey("AMUX_DAEMON_SESSION")).toBe(true);
    expect(isProcessPluginProtectedEnvKey("PATH")).toBe(false);
  }),
);

testEffect("injects daemon session and startup event", () =>
  Effect.gen(function* () {
    const env = yield* processPluginLaunchEnv({
      plugin,
      pluginRoot: "/plugins/example.tools",
      binPath: "/usr/bin/amux",
      daemonSession: "sess-1",
      controlSocket: "/tmp/control.sock",
      event: "startup",
      configRoot: "/cfg",
      stateRoot: "/state",
    });
    expect(env.AMUX_DAEMON_SESSION).toBe("sess-1");
    expect(env.AMUX_CONTROL_SOCKET).toBe("/tmp/control.sock");
    expect(env.AMUX_PLUGIN_EVENT).toBe("startup");
  }),
);
