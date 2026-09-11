import { expect, test } from "bun:test";
import { Effect } from "effect";
import { processPluginInvocationContextFromWorkspace } from "./context.ts";
import { enrichProcessPluginPaneEnv } from "./resolve.ts";
import { workspaceFromSession } from "../workspace.ts";
import type { SessionState } from "../session.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);

const base = (): SessionState => ({
  version: 1,
  id: "model",
  createdAt: 1,
  updatedAt: 1,
  attached: false,
  activeSpace: "space-a",
  spaces: [
    {
      id: "space-a",
      name: "project",
      dir: "/work/project",
      activeWindow: 1,
      windows: [
        {
          number: 1,
          name: "main",
          sessions: [
            {
              id: "agent-a",
              name: "sh",
              cmd: ["sh"],
              cwd: "/work/project/src",
              cols: 80,
              rows: 24,
              exited: false,
              exitCode: null,
            },
          ],
          layout:
            '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
        },
      ],
    },
  ],
});

test("processPluginInvocationContextFromWorkspace fills space/window/pane", () => {
  const workspace = run(workspaceFromSession(base()));
  const context = processPluginInvocationContextFromWorkspace({
    workspace,
    commandContext: { pane: "pane-a", cwd: "/fallback" },
    invocationSource: "test",
    correlationId: "ctx-1",
  });
  expect(context).toEqual({
    spaceId: "space-a",
    spaceLabel: "project",
    spaceCwd: "/work/project",
    windowNumber: 1,
    windowLabel: "main",
    focusedPaneId: "pane-a",
    focusedPaneCwd: "/work/project/src",
    invocationSource: "test",
    correlationId: "ctx-1",
  });
});

test("processPluginInvocationContextFromWorkspace falls back to focused pane", () => {
  const workspace = run(workspaceFromSession(base()));
  const context = processPluginInvocationContextFromWorkspace({
    workspace,
    commandContext: { cwd: "/fallback" },
    invocationSource: "daemon",
  });
  expect(context.focusedPaneId).toBe("pane-a");
  expect(context.spaceId).toBe("space-a");
  expect(context.invocationSource).toBe("daemon");
});

test("enrichProcessPluginPaneEnv rewrites context and sockets", () => {
  const env = enrichProcessPluginPaneEnv(
    { AMUX_PLUGIN_ID: "examples.smoke", AMUX_PLUGIN_CONTEXT_JSON: '{"invocationSource":"cli"}' },
    {
      context: { spaceId: "space-a", invocationSource: "daemon" },
      controlSocket: "/tmp/control.sock",
      processStateSocket: "/tmp/ps.sock",
      binPath: "/usr/bin/amux",
    },
  );
  expect(JSON.parse(env.AMUX_PLUGIN_CONTEXT_JSON!)).toEqual({
    spaceId: "space-a",
    invocationSource: "daemon",
  });
  expect(env.AMUX_CONTROL_SOCKET).toBe("/tmp/control.sock");
  expect(env.AMUX_PROCESS_STATE_SOCKET).toBe("/tmp/ps.sock");
  expect(env.AMUX_BIN_PATH).toBe("/usr/bin/amux");
  expect(env.AMUX_PLUGIN_ID).toBe("examples.smoke");
});
