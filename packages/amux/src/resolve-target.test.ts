import { expect, test } from "bun:test";
import { Effect } from "effect";
import { command, type RuntimeCommand } from "./commands.ts";
import { nodePath } from "./effect/node-path.ts";
import { layoutPanes } from "./layout.ts";
import { editorDaemonCommands } from "../../editor/src/daemon.ts";
import type { SessionState } from "./session.ts";
import {
  applyWorkspaceCommand as applyWorkspaceCommandWithPath,
  resolveTarget,
  workspaceFromSession,
  type WorkspaceCommandContext,
  type WorkspaceMutation,
  type WorkspaceSnapshot,
} from "./workspace.ts";
import type { DaemonCommandRegistration } from "./plugin/services.ts";
import {
  preparePluginCommandApply,
  workspaceTransactionPluginsFromRegistrations,
} from "./effect/WorkspaceTransaction.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const path = run(nodePath);

const pluginApplyFor = (
  regs: readonly DaemonCommandRegistration[],
  workspace: WorkspaceSnapshot,
  cmd: RuntimeCommand,
  context: WorkspaceCommandContext,
) =>
  run(
    preparePluginCommandApply(
      workspaceTransactionPluginsFromRegistrations(regs),
      cmd,
      workspace,
      context,
    ),
  );

const applyWorkspaceCommand = (
  workspace: Parameters<typeof applyWorkspaceCommandWithPath>[0],
  cmd: Parameters<typeof applyWorkspaceCommandWithPath>[1],
  context: Parameters<typeof applyWorkspaceCommandWithPath>[2],
  regs?: readonly DaemonCommandRegistration[],
): WorkspaceMutation => {
  const prepared =
    regs === undefined
      ? undefined
      : pluginApplyFor(regs, workspace, cmd as RuntimeCommand, context);
  return run(
    applyWorkspaceCommandWithPath(
      workspace,
      prepared?.command ?? cmd,
      context,
      path,
      prepared?.apply,
    ),
  );
};

const editorPlugins = editorDaemonCommands;

/** space-a focus pane-a; space-b has pane-b1 (agent-b1) and focused pane-b2. */
const fixture = (): SessionState => ({
  version: 1,
  id: "model",
  createdAt: 1,
  updatedAt: 1,
  attached: false,
  activeSpace: "space-a",
  nextSpace: 1,
  spaces: [
    {
      id: "space-a",
      name: "one",
      dir: "/tmp/one",
      activeWindow: 1,
      windows: [
        {
          number: 1,
          name: null,
          sessions: [
            {
              id: "agent-a",
              name: "cat",
              cmd: ["cat"],
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
    {
      id: "space-b",
      name: "two",
      dir: "/tmp/two",
      activeWindow: 1,
      windows: [
        {
          number: 1,
          name: null,
          sessions: [
            {
              id: "agent-b1",
              name: "cat",
              cmd: ["cat"],
              cols: 80,
              rows: 24,
              exited: false,
              exitCode: null,
            },
            {
              id: "agent-b2",
              name: "cat",
              cmd: ["cat"],
              cols: 80,
              rows: 24,
              exited: false,
              exitCode: null,
            },
          ],
          layout:
            '{"version":1,"root":{"type":"split","direction":"row","weight":1,"children":[{"type":"pane","id":"pane-b1","content":{"kind":"pty","session":"agent-b1"},"weight":1},{"type":"pane","id":"pane-b2","content":{"kind":"pty","session":"agent-b2"},"weight":1}]},"focus":"pane-b2"}',
        },
      ],
    },
  ],
});

const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

test("resolveTarget prefers a named pane", () => {
  const workspace = run(workspaceFromSession(fixture()));
  const target = resolveTarget(workspace, { pane: "pane-b2" }, { pane: "pane-b1" });
  expect(target?.pane.id).toBe("pane-b2");
});

test("resolveTarget prefers the agent pane over a stale caller pane id", () => {
  const workspace = run(workspaceFromSession(fixture()));
  const target = resolveTarget(workspace, {}, { agent: "agent-b1", pane: "pane-a" });
  expect(target?.pane.id).toBe("pane-b1");
});

test("resolveTarget prefers the caller pane over focus", () => {
  const workspace = run(workspaceFromSession(fixture()));
  const target = resolveTarget(workspace, {}, { pane: "pane-b1" });
  expect(target?.pane.id).toBe("pane-b1");
});

test("resolveTarget falls back to the focused pane when there is no caller", () => {
  const workspace = run(workspaceFromSession(fixture()));
  const target = resolveTarget(workspace, {}, {});
  expect(target?.pane.id).toBe("pane-a");
});

test("an agent on no pane and no roster does not fall back to the active window", () => {
  const workspace = run(workspaceFromSession(fixture()));
  const next = applyWorkspaceCommand(workspace, command("pane.next"), {
    ...context,
    agent: "missing-agent",
  });
  expect(next.snapshot).toEqual(workspace);
  expect(resolveTarget(workspace, {}, { agent: "missing-agent" })).toBeNull();
});

test("pane.current and pane.layout use the same resolveTarget rule", () => {
  const workspace = run(workspaceFromSession(fixture()));
  const caller = { agent: "agent-b1", pane: "pane-a" };
  const read = applyWorkspaceCommand(workspace, command("pane.current"), {
    ...context,
    ...caller,
  });
  expect((read.result as { id: string }).id).toBe("pane-b1");
  const layout = applyWorkspaceCommand(workspace, command("pane.layout"), {
    ...context,
    ...caller,
  });
  expect((layout.result as { pane: string }).pane).toBe("pane-b1");
});

test("placement replace uses the same resolveTarget rule", () => {
  const workspace = run(workspaceFromSession(fixture()));
  const opened = applyWorkspaceCommand(
    workspace,
    { _tag: "editor.open" },
    { ...context, pane: "pane-b1" },
    editorPlugins,
  );
  expect(opened.result).toEqual({ pane: "pane-b1" });
  const window = opened.snapshot.spaces.find((space) => space.id === "space-b")!.windows[0]!;
  expect(layoutPanes(window.layout.root).find((pane) => pane.id === "pane-b1")!.content).toEqual({
    kind: "plugin",
    type: "amux.editor",
    descriptor: {},
    displaced: "agent-b1",
  });
});
