import { expect, test } from "bun:test";
import { Effect } from "effect";
import { command } from "../commands.ts";
import {
  applyWorkspaceCommand,
  markSessionExited,
  workspaceFromSession,
} from "../workspace.ts";
import type { SessionState } from "../session.ts";
import { KeyInvocation } from "../key-invocation.ts";
import { placementOf } from "../layout.ts";
import {
  processPluginActionBindingName,
  processPluginBindingSpecs,
  processPluginPaneBindingName,
} from "./bindings.ts";
import type { LinkedProcessPluginInfo } from "./registry.ts";

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
      dir: "/tmp",
      activeWindow: 1,
      windows: [
        {
          number: 1,
          name: null,
          sessions: [
            {
              id: "agent-a",
              name: "sh",
              cmd: ["sh"],
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

const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

test("process-plugin.pane.open with resolved fields spawns session", () => {
  const workspace = run(workspaceFromSession(base()));
  const mutation = applyWorkspaceCommand(
    workspace,
    command("process-plugin.pane.open", {
      plugin: "examples.smoke",
      entrypoint: "board",
      command: ["htop"],
      env: { AMUX_PLUGIN_ID: "examples.smoke", AMUX_ENV: "1" },
      cwd: "/plugins/example",
      title: "Board",
      axis: "row",
    }),
    context,
  );
  expect(mutation.changed).toBe(true);
  const spawn = mutation.actions.find(
    (action): action is Extract<typeof action, { _tag: "spawn" }> => action._tag === "spawn",
  );
  expect(spawn?.agent.cmd).toEqual(["htop"]);
  expect(spawn?.agent.name).toBe("Board");
  expect(spawn?.agent.env).toEqual({ AMUX_PLUGIN_ID: "examples.smoke", AMUX_ENV: "1" });
  const result = mutation.result as { pane: string };
  const layout = mutation.snapshot.spaces[0]!.windows[0]!.layout;
  expect(placementOf(layout, result.pane)).toBe("tiled");
});

test("process-plugin.pane.open placement=floating uses setPlacement", () => {
  const workspace = run(workspaceFromSession(base()));
  const mutation = applyWorkspaceCommand(
    workspace,
    command("process-plugin.pane.open", {
      plugin: "examples.smoke",
      entrypoint: "board",
      command: ["htop"],
      title: "Board",
      placement: "floating",
      transient: true,
    }),
    context,
  );
  expect(mutation.changed).toBe(true);
  const result = mutation.result as { session: string; pane: string };
  const window = mutation.snapshot.spaces[0]!.windows[0]!;
  expect(placementOf(window.layout, result.pane)).toBe("floating");
  expect(window.state.focus).toBe(result.pane);
  expect(window.state.last).toBe("pane-a");
  const spawned = window.sessions.find((session) => session.id === result.session);
  expect(spawned?.transient).toBe(true);

  const afterExit = markSessionExited(mutation.snapshot, result.session, 0);
  const afterWindow = afterExit.spaces[0]!.windows[0]!;
  expect(afterWindow.state.focus).toBe("pane-a");
});

test("process-plugin.pane.open without resolved command is a no-op", () => {
  const workspace = run(workspaceFromSession(base()));
  const mutation = applyWorkspaceCommand(
    workspace,
    command("process-plugin.pane.open", {
      plugin: "examples.smoke",
      entrypoint: "board",
    }),
    context,
  );
  expect(mutation.changed).toBe(false);
  expect(mutation.actions).toEqual([]);
});

test("processPluginBindingSpecs emits unbound action and pane entries", () => {
  const plugin: LinkedProcessPluginInfo = {
    pluginId: "examples.smoke",
    name: "Smoke",
    version: "0.1.0",
    pluginRoot: "/tmp/smoke",
    enabled: true,
    linkedAtUnixMs: 1,
    manifest: {
      id: "examples.smoke",
      name: "Smoke",
      version: "0.1.0",
      actions: [{ id: "ping", title: "Ping", command: ["true"] }],
      panes: [
        {
          id: "board",
          title: "Board",
          command: ["sleep", "infinity"],
          placement: "tiled",
          transient: false,
        },
      ],
      startup: [],
    },
  };
  const ran: string[] = [];
  const specs = processPluginBindingSpecs([plugin], {
    runAction: (pluginId, actionId) =>
      Effect.sync(() => {
        ran.push(`action:${pluginId}:${actionId}`);
      }),
    runPane: (pluginId, entrypointId) =>
      Effect.sync(() => {
        ran.push(`pane:${pluginId}:${entrypointId}`);
      }),
  });
  expect(specs.map((s) => s.name)).toEqual([
    processPluginActionBindingName("examples.smoke", "ping"),
    processPluginPaneBindingName("examples.smoke", "board"),
  ]);
  expect(specs.every((s) => s.key === undefined)).toBe(true);
  expect(specs[0]?.desc).toBe("Smoke: Ping");
  expect(specs[1]?.desc).toBe("Smoke: Board");
  const withKey = <A, E>(effect: Effect.Effect<A, E, KeyInvocation>) =>
    effect.pipe(
      Effect.provideService(KeyInvocation, {
        event: {} as never,
        data: {},
        input: "",
        payload: undefined,
      }),
    );
  Effect.runSync(withKey(specs[0]!.run));
  Effect.runSync(withKey(specs[1]!.run));
  expect(ran).toEqual(["action:examples.smoke:ping", "pane:examples.smoke:board"]);
});
