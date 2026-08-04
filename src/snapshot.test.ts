import { test, expect, afterEach } from "bun:test";
import { createHarness, run } from "./harness.ts";
import { RenderState } from "./ghostty.ts";
import { encodeLayout, decodeLayout, layoutAgents } from "./layout.ts";
import {
  restoreSession,
  restoreSpaces,
  snapshotSession,
  snapshotSpace,
  snapshotWindow,
} from "./snapshot.ts";
import { SESSION_VERSION, type PersistedSpace, type SessionState } from "./session.ts";
import type { Agent } from "./agent.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup(options?: Parameters<typeof createHarness>[0]) {
  const harness = await createHarness(options);
  cleanup.push(harness.dispose);
  return harness;
}

const session = (spaces: PersistedSpace[], activeSpace?: string | null): SessionState => ({
  version: SESSION_VERSION,
  id: "test",
  createdAt: 1,
  updatedAt: 1,
  attached: false,
  activeSpace,
  spaces,
});

function screenTail(agent: Agent): string {
  const state = new RenderState();
  try {
    state.update(agent.term);
    return state.tailText(24).join("\n");
  } finally {
    state.free();
  }
}

// Snapshot.

test("a window snapshot records its agents and the arrangement of them", async () => {
  const { window, layout } = await setup();
  const first = window.panes[0]!;
  const second = run(window.splitSpawn("row"))!;
  await layout();

  const saved = snapshotWindow(window);
  expect(saved.number).toBe(window.number);
  expect(saved.agents.map((a) => a.id)).toEqual([first.agent.id, second.agent.id]);
  // The flat list cannot say how they were placed, nor which of them was
  // focused; the layout string says both, and is the only record of either.
  expect(layoutAgents(decodeLayout(saved.layout!))).toEqual([first.agent.id, second.agent.id]);
  expect(decodeLayout(saved.layout!).focus).toBe(second.id);
});

test("a snapshot records an agent's command, directory and terminal size", async () => {
  const { window, layout } = await setup();
  await layout();
  const [agent] = snapshotWindow(window).agents;
  expect(agent!.cmd).toEqual(["bash"]);
  expect(agent!.cwd).toBe(process.cwd());
  expect(agent!.cols).toBe(window.panes[0]!.agent.term.cols);
  expect(agent!.rows).toBe(window.panes[0]!.agent.term.rows);
  expect(agent!.exited).toBe(false);
});

test("a space snapshot records which window was selected", async () => {
  const { space, layout } = await setup();
  const second = run(space.newWindow("build"));
  run(second.init());
  await layout();

  const saved = snapshotSpace(space);
  expect(saved.windows.map((w) => w.number)).toEqual([1, 2]);
  expect(saved.windows[1]!.name).toBe("build");
  expect(saved.activeWindow).toBe(second.number);
});

// An agent with no pane is still the window's, so it must still be recorded —
// otherwise detaching a view would quietly discard a running process.
test("agents with no pane open are recorded, and are absent from the layout", async () => {
  const { window, layout } = await setup();
  const kept = window.panes[0]!;
  const detached = run(window.splitSpawn("row"))!;
  await layout();
  const hidden = detached.agent;
  window.close(detached);
  await layout();

  const saved = snapshotWindow(window);
  expect(saved.agents.map((a) => a.id)).toContain(hidden.id);
  expect(layoutAgents(decodeLayout(saved.layout!))).toEqual([kept.agent.id]);
});

// Restore.

test("a restored window comes back with the same panes in the same shape", async () => {
  const source = await setup();
  run(source.window.splitSpawn("row"));
  run(source.window.splitSpawn("column"));
  await source.layout();
  const saved = snapshotSpace(source.space);

  const target = source.takeOver();
  run(restoreSpaces(target, [saved]));
  await source.layout();

  const restored = target.spaces[0]!.windows[0]!;
  expect(restored.panes).toHaveLength(3);
  expect(restored.panes.map((p) => p.agent.id)).toEqual(source.window.panes.map((p) => p.agent.id));
  expect(encodeLayout(restored.exportLayout())).toBe(saved.windows[0]!.layout!);
});

/**
 * Focus is in the layout and nowhere else, and it survives being the second of
 * two panes onto one agent — the case the old `focusedAgent` field could not
 * describe at all, since both panes answered to the same name.
 */
test("a restored window focuses the pane that had focus, not merely its agent", async () => {
  const source = await setup();
  const shared = run(source.window.spawn("shared", ["sleep", "30"]));
  source.window.split("row", shared);
  const focused = source.window.split("row", shared)!;
  await source.layout();
  expect(source.window.focused).toBe(focused);
  const saved = snapshotSpace(source.space);

  const target = source.takeOver();
  run(restoreSpaces(target, [saved]));
  await source.layout();

  const restored = target.spaces[0]!.windows[0]!;
  const onShared = restored.panes.filter((p) => p.agent.id === shared.id);
  expect(onShared).toHaveLength(2);
  // Pane ids survive the round trip, so the SECOND one is focused rather than
  // whichever pane showing that agent happened to come first.
  expect(restored.focused).toBe(onShared[1]!);
  expect(restored.focused!.id).toBe(focused.id);
});

// The strongest statement of the format's completeness: everything a snapshot
// records survives being rebuilt from it, so restoring twice cannot drift.
test("snapshotting a restored workspace reproduces the snapshot it came from", async () => {
  const source = await setup();
  run(source.window.splitSpawn("row"));
  run(source.window.splitSpawn("column"));
  run(run(source.space.newWindow("second")).init());
  await source.layout();
  const before = snapshotSession(source.spaces, session([]));

  const target = source.takeOver();
  run(restoreSession(target, before));
  await source.layout();

  const after = snapshotSession(target, session([]));
  expect(after.spaces).toEqual(before.spaces);
  expect(after.activeSpace).toBe(before.activeSpace);
});

test("window numbers survive, and a window made afterwards does not reuse one", async () => {
  const source = await setup();
  run(run(source.space.newWindow()).init());
  run(run(source.space.newWindow()).init());
  await source.layout();
  const saved = snapshotSpace(source.space);
  expect(saved.windows.map((w) => w.number)).toEqual([1, 2, 3]);

  const target = source.takeOver();
  const [space] = run(restoreSpaces(target, [saved]));
  await source.layout();

  expect(space!.windows.map((w) => w.number)).toEqual([1, 2, 3]);
  expect(run(space!.newWindow()).number).toBe(4);
});

test("the focused pane and the selected window come back", async () => {
  const source = await setup();
  const first = source.window.panes[0]!;
  run(source.window.splitSpawn("row"));
  await source.layout();
  source.window.focus(first);
  const second = run(source.space.newWindow());
  run(second.init());
  source.space.selectWindow(source.window);
  await source.layout();
  const saved = snapshotSpace(source.space);

  const target = source.takeOver();
  const [space] = run(restoreSpaces(target, [saved]));
  await source.layout();

  expect(space!.active?.number).toBe(1);
  expect(space!.active?.focused?.agent.id).toBe(first.agent.id);
});

test("the active space comes back, not merely the first one restored", async () => {
  const source = await setup();
  const other = run(source.spaces.create("other", process.cwd()));
  run(run(other.newWindow()).init());
  source.spaces.activate(other);
  await source.layout();
  const saved = snapshotSession(source.spaces, session([]));
  expect(saved.activeSpace).toBe(other.id);

  const target = source.takeOver();
  run(restoreSession(target, saved));
  await source.layout();
  expect(target.active?.name).toBe("other");
});

test("two panes on one agent are still two panes after a restore", async () => {
  const source = await setup();
  const shared = run(source.window.spawn("shared", ["sleep", "30"]));
  source.window.split("row", shared);
  source.window.split("row", shared);
  await source.layout();
  const saved = snapshotSpace(source.space);

  const target = source.takeOver();
  const [space] = run(restoreSpaces(target, [saved]));
  await source.layout();

  const restored = space!.windows[0]!;
  expect(restored.panes.filter((p) => p.agent.id === shared.id)).toHaveLength(2);
});

// Terminal geometry is part of the arrangement: a restored agent whose shell
// believes it has 80 columns inside a 40-column pane wraps everything wrongly.
test("a restored agent's terminal is sized to the pane it lands in", async () => {
  const source = await setup();
  run(source.window.splitSpawn("row"));
  await source.layout();
  const saved = snapshotSpace(source.space);

  const target = source.takeOver();
  const [space] = run(restoreSpaces(target, [saved]));
  await source.layout();

  const restored = space!.windows[0]!;
  expect(restored.panes.map((p) => p.agent.term.cols)).toEqual(
    source.window.panes.map((p) => p.agent.term.cols),
  );
  expect(restored.panes[0]!.agent.term.cols).toBeLessThan(source.window.root.width);
});

// Exited agents.

test("an agent that had exited comes back as a tombstone, not a second run", async () => {
  const source = await setup();
  const target = source.takeOver();
  run(
    restoreSpaces(target, [
      {
        id: "space-0",
        name: "proj",
        dir: process.cwd(),
        activeWindow: 1,
        windows: [
          {
            number: 1,
            name: null,
            layout: null,
            agents: [
              {
                id: "agent-dead",
                name: "build",
                cmd: ["bash", "-c", "echo tombstone-should-not-run"],
                cols: 80,
                rows: 24,
                exited: true,
                exitCode: 3,
              },
            ],
          },
        ],
      },
    ]),
  );
  await source.layout();
  // Long enough that a process, had one been started, would have printed.
  await Bun.sleep(200);

  const window = target.spaces[0]!.windows[0]!;
  const [agent] = window.agents;
  expect(agent!.exited).toBe(true);
  expect(agent!.exitCode).toBe(3);
  expect(agent!.state).toBe("done");
  expect(screenTail(agent!)).not.toContain("tombstone-should-not-run");
  // No view, which is exactly where an exit leaves an agent in the live app.
  expect(window.panes).toHaveLength(0);
  expect(window.detached).toEqual([agent!]);
});

test("a window restores its live agents even when one of them is a tombstone", async () => {
  const source = await setup();
  const alive = source.window.panes[0]!.agent;
  await source.layout();
  const saved = snapshotSpace(source.space);
  saved.windows[0]!.agents.push({
    id: "agent-dead",
    name: "gone",
    cmd: ["true"],
    cols: 80,
    rows: 24,
    exited: true,
    exitCode: 0,
  });

  const target = source.takeOver();
  const [space] = run(restoreSpaces(target, [saved]));
  await source.layout();

  const window = space!.windows[0]!;
  expect(window.agents).toHaveLength(2);
  expect(window.panes.map((p) => p.agent.id)).toEqual([alive.id]);
});

// A layout that names a dead agent would otherwise build it a pane, which is a
// view onto a terminal nothing will ever write to again.
test("a tombstone named by the saved layout still gets no pane", async () => {
  const source = await setup();
  const alive = source.window.panes[0]!.agent;
  const doomed = run(source.window.splitSpawn("row"))!.agent;
  await source.layout();
  const saved = snapshotSpace(source.space);
  // The layout still mentions both, but one is recorded as already finished.
  expect(layoutAgents(decodeLayout(saved.windows[0]!.layout!))).toHaveLength(2);
  const dead = saved.windows[0]!.agents.find((a) => a.id === doomed.id)!;
  dead.exited = true;
  dead.exitCode = 1;

  const target = source.takeOver();
  const [space] = run(restoreSpaces(target, [saved]));
  await source.layout();

  const window = space!.windows[0]!;
  expect(window.panes.map((p) => p.agent.id)).toEqual([alive.id]);
  // The survivor takes the whole window rather than half of a stale split.
  expect(window.panes[0]!.width).toBe(window.root.width);
});

// Degraded input.

test("a session file with no layout recorded still restores every agent", async () => {
  const source = await setup();
  run(source.window.splitSpawn("row"));
  await source.layout();
  const saved = snapshotSpace(source.space);
  const ids = saved.windows[0]!.agents.map((a) => a.id);
  delete saved.windows[0]!.layout;

  const target = source.takeOver();
  const [space] = run(restoreSpaces(target, [saved]));
  await source.layout();

  expect(space!.windows[0]!.panes.map((p) => p.agent.id)).toEqual(ids);
});

test("a layout string that no longer parses falls back rather than losing the window", async () => {
  const source = await setup();
  run(source.window.splitSpawn("row"));
  await source.layout();
  const saved = snapshotSpace(source.space);
  const ids = saved.windows[0]!.agents.map((a) => a.id);
  saved.windows[0]!.layout = "{ this was hand-edited";

  const target = source.takeOver();
  const [space] = run(restoreSpaces(target, [saved]));
  await source.layout();

  expect(space!.windows[0]!.panes.map((p) => p.agent.id)).toEqual(ids);
});

test("a layout naming an agent that did not come back restores the ones that did", async () => {
  const source = await setup();
  run(source.window.splitSpawn("row"));
  await source.layout();
  const saved = snapshotSpace(source.space);
  const kept = saved.windows[0]!.agents[0]!.id;
  // Drop the second agent from the list but leave it in the layout, the shape a
  // half-written or hand-edited file has.
  saved.windows[0]!.agents.length = 1;

  const target = source.takeOver();
  const [space] = run(restoreSpaces(target, [saved]));
  await source.layout();

  expect(space!.windows[0]!.panes.map((p) => p.agent.id)).toEqual([kept]);
});

// Identity.

test("an agent created after a restore cannot collide with a restored id", async () => {
  const source = await setup();
  const target = source.takeOver();
  run(
    restoreSpaces(target, [
      {
        id: "space-99",
        name: "proj",
        dir: process.cwd(),
        activeWindow: 1,
        windows: [
          {
            number: 1,
            name: null,
            layout: null,
            agents: [
              {
                id: "agent-9000",
                name: "sh",
                cmd: ["sleep", "30"],
                cols: 80,
                rows: 24,
                exited: false,
                exitCode: null,
              },
            ],
          },
        ],
      },
    ]),
  );
  await source.layout();

  const window = target.spaces[0]!.windows[0]!;
  const fresh = run(window.spawn(undefined, ["sleep", "30"]));
  expect(fresh.id).not.toBe("agent-9000");
  expect(target.spaces[0]!.id).toBe("space-99");
  expect(run(target.create("later", process.cwd())).id).not.toBe("space-99");
});

// The documented limit.

test("a restored agent runs its command again and does NOT get its screen back", async () => {
  const source = await setup({ shell: ["bash", "--norc", "-i"] });
  const agent = source.window.panes[0]!.agent;
  agent.write("echo snapshot-marker-42\n");
  await Bun.sleep(400);
  expect(screenTail(agent)).toContain("snapshot-marker-42");
  await source.layout();
  const saved = snapshotSpace(source.space);
  // Nothing in the file even claims to hold the screen.
  expect(JSON.stringify(saved)).not.toContain("snapshot-marker-42");

  const target = source.takeOver();
  const [space] = run(restoreSpaces(target, [saved]));
  await source.layout();
  await Bun.sleep(400);

  const restored = space!.windows[0]!.panes[0]!.agent;
  // A live process, at the same command — but a fresh screen. See snapshot.ts.
  expect(restored.exited).toBe(false);
  expect(restored.cmd).toEqual(["bash", "--norc", "-i"]);
  expect(screenTail(restored)).not.toContain("snapshot-marker-42");
});
