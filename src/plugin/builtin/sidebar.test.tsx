/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { BoxRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { testRender, useRenderer } from "@opentui/solid";
import { createSignal, onMount } from "solid-js";
import { SpaceSet, type Space } from "../../space.ts";
import { sidebarPlugin } from "./sidebar.tsx";
import { type SidebarDisplay, type SidebarDisplayRow } from "../../ui/panel.ts";
import { createRegions } from "../../ui/regions.tsx";
import { createPluginContributions } from "../contributions.ts";
import { workspaceEnv } from "../../env.ts";
import { createPluginHost, type PluginHost } from "../../plugin/host.ts";
import { testPluginEnvironment } from "../test-environment.ts";
import { testPanelContext } from "../../ui/test-panel.ts";
import { formatText } from "../../format.ts";
import { resolveOptions } from "../../options.ts";

test("format strings can choose the command or OSC title in a sidebar row", () => {
  expect(
    formatText("#{pane_current_command} · #{pane_title}", {
      pane_current_command: "bun",
      pane_title: "tests",
    }),
  ).toBe("bun · tests");
});

const WIDTH = 60;
const HEIGHT = 20;

function computeDisplay(spaces: SpaceSet): SidebarDisplay {
  const rows: SidebarDisplayRow[] = [];
  let index = 0;
  const active = spaces.active;
  const activeWin = spaces.activeWindow;
  const focusedAgent = activeWin?.focused?.session ?? null;

  for (const space of spaces.spaces) {
    const isActiveSpace = space === active;
    rows.push({
      kind: "space",
      index: index++,
      spaceId: space.id,
      spaceName: space.name,
      active: isActiveSpace,
    });

    if (space.branch) {
      rows.push({
        kind: "branch",
        index,
        spaceId: space.id,
        spaceName: space.name,
        active: isActiveSpace,
        branch: space.branch,
        ahead: space.ahead,
        behind: space.behind,
      });
    }

    for (const window of space.windows) {
      const isActiveWindow = isActiveSpace && space.active === window;
      rows.push({
        kind: "window",
        index: index++,
        spaceId: space.id,
        spaceName: space.name,
        active: isActiveWindow,
        windowNumber: window.number,
        windowLabel: window.label,
      });

      for (const agent of window.sessions) {
        const isFocusedAgent = isActiveWindow && agent === focusedAgent;
        rows.push({
          kind: "agent",
          index: index++,
          spaceId: space.id,
          spaceName: space.name,
          active: isFocusedAgent,
          windowNumber: window.number,
          windowLabel: window.label,
          agentId: agent.id,
          agentState: agent.state,
          agentCliKind: agent.agentKind,
          agentSessionKind: agent.kind,
          title: agent.title,
          foregroundCommand: agent.foregroundCommand,
          viewers: agent.viewers,
          unseen: agent.unseen,
          scrolled: agent.scrolled,
          exited: agent.exited,
        });
      }
    }
  }

  const allAgents = spaces.allSessions.filter((a) => !a.exited);
  const blocked = allAgents.filter((a) => a.state === "blocked").length;

  return {
    rows,
    spaceCount: spaces.spaces.length,
    agentCount: allAgents.length,
    blockedCount: blocked,
  };
}

const cleanupFns: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanupFns.splice(0)) await fn();
});

async function setup(options?: { width?: number; height?: number; format?: string }) {
  const w = options?.width ?? WIDTH;
  const h = options?.height ?? HEIGHT;
  const shell = ["bash", "--norc", "--noprofile"];

  let spaces!: SpaceSet;
  let space!: Space;
  let win!: Space["windows"][number];
  let regions!: ReturnType<typeof createRegions>;
  let scope!: Scope.CloseableScope;
  let ready!: () => void;
  const initialized = new Promise<void>((resolve) => (ready = resolve));

  const t = await testRender(
    () => {
      const renderer = useRenderer();
      const contributions = createPluginContributions();
      const registeredRegions = createRegions(renderer, contributions);
      const paneHost = new BoxRenderable(renderer, { id: "pane-host", flexGrow: 1 });
      onMount(() => {
        regions = registeredRegions;
        scope = Effect.runSync(Scope.make());
        spaces = Effect.runSync(
          Scope.extend(SpaceSet.make(workspaceEnv(renderer, { shell }), paneHost), scope),
        );
        space = Effect.runSync(spaces.create("proj", process.cwd()));
        win = Effect.runSync(space.newWindow());
        Effect.runSync(win!.init("shell"));
        const [displaySignal, setDisplaySignal] = createSignal(computeDisplay(spaces));
        spaces.onChange = () => setDisplaySignal(computeDisplay(spaces));
        const panelCtx = testPanelContext({
          display: displaySignal,
          options: () =>
            resolveOptions(options?.format ? { "sidebar.format": options.format } : {}),
        });
        const environment = testPluginEnvironment(renderer, {
          panel: panelCtx,
          contributions,
          regions: registeredRegions,
        });
        const host: PluginHost = Effect.runSync(
          Scope.extend(
            createPluginHost(environment).pipe(Effect.provideService(Scope.Scope, scope)),
            scope,
          ),
        );
        Effect.runSync(Scope.extend(host.add(sidebarPlugin), scope));
        ready();
      });

      return (
        <box style={{ width: "100%", height: "100%", flexDirection: "row" }}>
          <box
            style={{
              width: 30,
              height: "100%",
              flexShrink: 0,
              flexDirection: "column",
              position: "relative",
            }}
          >
            <registeredRegions.Slot name="left.app" side="left" anchor="app" />
            {registeredRegions.divider("left", "app")}
          </box>
          {paneHost}
        </box>
      );
    },
    { width: w, height: h },
  );
  await initialized;
  await t.renderOnce();
  cleanupFns.push(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await Bun.sleep(50);
    t.renderer.destroy();
  });
  return { t, spaces, space, win, regions };
}

function refreshDisplay(spaces: SpaceSet): void {
  spaces.onChange?.();
}

// -- Pure data tests --

interface AgentRowDef {
  name: string;
  cmd: string[];
  agentKind?: string | null;
  state?: string;
  exited?: boolean;
  focused?: boolean;
}

interface WindowRowDef {
  a: AgentRowDef[];
}

interface SpaceRowDef {
  s: string;
  active?: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  w: WindowRowDef[];
}

function displayRows(spaces: SpaceRowDef[]): SidebarDisplayRow[] {
  const rows: SidebarDisplayRow[] = [];
  let index = 0;
  for (const [spaceIndex, space] of spaces.entries()) {
    const active = space.active ?? false;
    rows.push({
      kind: "space",
      index: index++,
      spaceId: space.s,
      spaceName: space.s,
      spaceIndex,
      active,
    });
    if (space.branch)
      rows.push({
        kind: "branch",
        index,
        spaceId: space.s,
        spaceName: space.s,
        spaceIndex,
        active,
        branch: space.branch,
        ahead: space.ahead,
        behind: space.behind,
      });
    for (const [wi, window] of space.w.entries()) {
      const winNum = wi + 1;
      rows.push({
        kind: "window",
        index: index++,
        spaceId: space.s,
        spaceName: space.s,
        spaceIndex,
        active,
        windowNumber: winNum,
        windowLabel: `${winNum}:${window.a[0]?.name ?? "window"}`,
      });
      for (const [paneIndex, agent] of window.a.entries()) {
        const agentId = agent.name + "-id";
        rows.push({
          kind: "agent",
          index: index++,
          spaceId: space.s,
          spaceName: space.s,
          spaceIndex,
          active: agent.focused ?? false,
          agentId,
          paneIndex,
          agentState: agent.state ?? (agent.exited ? "done" : "idle"),
          agentCliKind: agent.agentKind ?? null,
          agentSessionKind: "pty",
          title: agent.name,
          foregroundCommand: null,
          viewers: 1,
          unseen: false,
          scrolled: false,
          exited: agent.exited ?? false,
        });
      }
    }
  }
  return rows;
}

test("display rows include space, window, and agent entries", () => {
  const rows = displayRows([{ s: "proj", w: [{ a: [{ name: "bash", cmd: ["bash"] }] }] }]);
  expect(rows.map((r) => r.kind)).toEqual(["space", "window", "agent"]);
  expect(rows[0]!.spaceName).toBe("proj");
  expect(rows[1]!.windowNumber).toBe(1);
  expect(rows[2]!.agentSessionKind).toBe("pty");
});

test("display rows expose space and pane indices", () => {
  const rows = displayRows([
    {
      s: "one",
      w: [
        {
          a: [
            { name: "first", cmd: ["sh"] },
            { name: "second", cmd: ["sh"] },
          ],
        },
      ],
    },
    { s: "two", w: [{ a: [{ name: "third", cmd: ["sh"] }] }] },
  ]);
  expect(rows[0]!.spaceIndex).toBe(0);
  expect(rows.find((row) => row.kind === "agent")!.paneIndex).toBe(0);
  expect(
    rows.find((row) => row.kind === "agent" && row.spaceName === "one" && row.paneIndex === 1),
  ).toBeDefined();
  expect(rows.find((row) => row.kind === "agent" && row.spaceName === "two")!.spaceIndex).toBe(1);
});

test("branch row appears when space has a branch", () => {
  const rows = displayRows([
    {
      s: "proj",
      branch: "feat/x",
      ahead: 2,
      behind: 1,
      w: [{ a: [{ name: "bash", cmd: ["bash"] }] }],
    },
  ]);
  const branch = rows.find((r) => r.kind === "branch");
  expect(branch).toBeDefined();
  expect(branch!.branch).toBe("feat/x");
  expect(branch!.ahead).toBe(2);
  expect(branch!.behind).toBe(1);
});

test("active markers follow the focused hierarchy", () => {
  const rows = displayRows([
    { s: "proj", active: true, w: [{ a: [{ name: "bash", cmd: ["bash"], focused: true }] }] },
  ]);
  const space = rows.find((r) => r.kind === "space");
  const window = rows.find((r) => r.kind === "window");
  const agent = rows.find((r) => r.kind === "agent");
  expect(space!.active).toBe(true);
  expect(window!.active).toBe(true);
  expect(agent!.active).toBe(true);
});

test("window label carries the window number and title", () => {
  const rows = displayRows([{ s: "proj", w: [{ a: [{ name: "bash", cmd: ["bash"] }] }] }]);
  const window = rows.find((r) => r.kind === "window");
  expect(window!.windowLabel).toMatch(/^1:/);
});

// -- Render tests --

test("renders the space/agent tree with a state glyph per row", async () => {
  const s = await setup();
  const frame = s.t.captureCharFrame();
  expect(frame).toContain("proj");
  expect(frame).toContain("1 space · 1 agent");
  expect(frame).toMatch(/[○●!✓⊘⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test("renders the configured sidebar format", async () => {
  const s = await setup({ format: "#{space_name}/#{window_number}/#{pane_index}" });
  const frame = s.t.captureCharFrame();
  expect(frame).toContain("proj/1/");
});

test("the footer counts what the tree shows", async () => {
  const s = await setup();
  const frame = s.t.captureCharFrame();
  expect(frame).toContain("1 space · 1 agent");
  const second = Effect.runSync(s.space.newWindow());
  Effect.runSync(second.init("shell"));
  refreshDisplay(s.spaces);
  await s.t.renderOnce();
  expect(s.t.captureCharFrame()).toContain("1 space · 2 agents");
});

test("the branch row appears under its space once git info arrives", async () => {
  const s = await setup();
  expect(s.t.captureCharFrame()).not.toContain("feat/thing");
  s.space.branch = "feat/thing";
  s.space.ahead = 2;
  s.space.behind = 1;
  await s.t.renderOnce();
  const display = computeDisplay(s.spaces);
  const branch = display.rows.find((r) => r.kind === "branch");
  expect(branch).toBeDefined();
  expect(branch!.branch).toBe("feat/thing");
  expect(branch!.ahead).toBe(2);
  expect(branch!.behind).toBe(1);
});

test("agents-only filtering shows only agent CLI agents", () => {
  const rows = displayRows([
    {
      s: "proj",
      w: [
        {
          a: [
            { name: "bash", cmd: ["bash"] },
            { name: "claude", cmd: ["claude"], agentKind: "claude" },
          ],
        },
      ],
    },
  ]);
  const hasBash = rows.some((r) => r.kind === "agent" && r.agentCliKind === null);
  const hasClaude = rows.some((r) => r.kind === "agent" && r.agentCliKind === "claude");
  expect(hasBash).toBe(true);
  expect(hasClaude).toBe(true);
});

test("blocked count appears in summary", () => {
  const rows = displayRows([
    {
      s: "proj",
      w: [{ a: [{ name: "claude", cmd: ["claude"], agentKind: "claude", state: "blocked" }] }],
    },
  ]);
  const agents = rows.filter((r) => r.kind === "agent");
  expect(agents.length).toBe(1);
  expect(agents[0]!.agentState).toBe("blocked");
});

test("exited agents are marked and excluded from agent count", () => {
  const rows = displayRows([
    {
      s: "proj",
      w: [
        {
          a: [
            { name: "bash", cmd: ["bash"] },
            { name: "done", cmd: ["echo", "hi"], exited: true },
          ],
        },
      ],
    },
  ]);
  const exited = rows.filter((r) => r.kind === "agent" && r.exited);
  expect(exited.length).toBe(1);
});

// -- Scrollbar tests --

function findScrollBox(root: unknown): ScrollBoxRenderable | null {
  if (!root) return null;
  const r = root as { constructor?: { name?: string }; getChildren?: () => unknown[] };
  if (r.constructor?.name === "ScrollBoxRenderable") return root as ScrollBoxRenderable;
  for (const child of r.getChildren?.() ?? []) {
    const found = findScrollBox(child);
    if (found) return found;
  }
  return null;
}

test("a tree that fits shows no scrollbar thumb on the first frame", async () => {
  const s = await setup();
  expect(s.t.captureCharFrame()).toContain("proj");
  const scrollBox = findScrollBox(s.t.renderer.root);
  expect(scrollBox?.verticalScrollBar.visible).toBe(false);
});
