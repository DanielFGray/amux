import { test, expect } from "bun:test";
import { which } from "bun";
import { BoxRenderable } from "@opentui/core";
import { mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Divider } from "./divider.ts";
import { applyOptions, resolveOptions } from "./options.ts";
import { rollUp, nextBlockedAfter } from "./space.ts";
import { createHarness, run, runAsync } from "./harness.ts";
import type { Window } from "./window.ts";
import type { Session } from "./agent.ts";
import type { AgentState } from "./agent-state.ts";

const SHELL = ["bash"];

/** These assert the domain, so no view is mounted. `win` rather than `window`
 *  throughout, which is why the shared harness is aliased rather than
 *  destructured. */
async function setup() {
  const harness = await createHarness({
    width: 100,
    height: 30,
    shell: SHELL,
    hostDirection: "row",
    init: "shell",
  });
  return { ...harness, win: harness.window };
}

/**
 * A stand-in for an agent CLI: a copy of bash under an agent's name, so a test
 * can drive what ends up on its screen. A copy rather than a wrapper script,
 * because state detection reads the foreground process's argv — see the note in
 * detect.test.ts.
 */
async function fakeAgent(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "amux-space-"));
  const path = join(dir, name);
  const bash = which("bash");
  if (!bash) throw new Error("no bash on PATH to impersonate");
  await Bun.write(path, Bun.file(bash));
  await chmod(path, 0o755);
  return path;
}

/** Poll until the agent's screen scan reports blocked; fail loudly otherwise. */
async function waitForBlocked(agent: Session, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (agent.state === "blocked") return;
    await Bun.sleep(100);
  }
  throw new Error(`agent ${agent.name} never read as blocked`);
}

/** Spawn a detached fake agent and put a confirmation prompt on its screen. */
async function blockedAgent(window: Window, name: string): Promise<Session> {
  const agent = run(
    window.spawn(name, [await fakeAgent("claude"), "--norc", "--noprofile"]),
  );
  await Bun.sleep(300);
  agent.write("printf 'Do you want to proceed?\\n'\n");
  await waitForBlocked(agent);
  return agent;
}

test("nextBlockedAfter walks the blocked set in a stable order, wrapping", () => {
  const stub = (state: AgentState) => ({ state }) as unknown as Session;
  const idle = stub("idle");
  const blocked1 = stub("blocked");
  const blocked2 = stub("blocked");
  const order = [idle, blocked1, idle, blocked2];

  expect(nextBlockedAfter([], null)).toBeNull();
  expect(nextBlockedAfter([stub("idle"), stub("working")], null)).toBeNull();

  // Nothing focused: the first blocked agent in order wins.
  expect(nextBlockedAfter(order, null)).toBe(blocked1);
  // From an idle agent: the next blocked one after it.
  expect(nextBlockedAfter(order, idle)).toBe(blocked1);
  // From a blocked agent: the NEXT one, never the one you are already looking at.
  expect(nextBlockedAfter(order, blocked1)).toBe(blocked2);
  // The last press wraps around to the first blocked agent again.
  expect(nextBlockedAfter(order, blocked2)).toBe(blocked1);
  // A lone blocked agent stays reachable from itself — a no-op, not a jump.
  expect(nextBlockedAfter([idle, blocked1], blocked1)).toBe(blocked1);
});

test("nextBlocked returns null when no agent is blocked", async () => {
  const s = await setup();
  try {
    expect(s.spaces.nextBlocked()).toBeNull();
  } finally {
    await s.dispose();
  }
});

test("nextBlocked activates the agent's space and window, walking in a stable order", async () => {
  const s = await setup();
  try {
    // Creation order is the walk order: A's shell, then B's blocked, then C's.
    // Focus stays on A's shell pane, so the presses land B, C, then wrap to B
    // — never bouncing between the last two.
    const otherB = run(s.spaces.create("B", process.cwd()));
    const winB = run(otherB.newWindow());
    run(winB.init("shell"));
    const blockedB = await blockedAgent(winB, "claude-b");

    const otherC = run(s.spaces.create("C", process.cwd()));
    const winC = run(otherC.newWindow());
    run(winC.init("shell"));
    const blockedC = await blockedAgent(winC, "claude-c");

    expect(s.spaces.nextBlocked()).toBe(blockedB);
    expect(s.spaces.active).toBe(otherB);
    expect(otherB.active).toBe(winB);
    expect(winB.focused?.session).toBe(blockedB);

    expect(s.spaces.nextBlocked()).toBe(blockedC);
    expect(s.spaces.active).toBe(otherC);
    expect(otherC.active).toBe(winC);
    expect(winC.focused?.session).toBe(blockedC);

    expect(s.spaces.nextBlocked()).toBe(blockedB);
    expect(s.spaces.active).toBe(otherB);
  } finally {
    await s.dispose();
  }
});

test("a detached blocked agent is revealed and focused by nextBlocked", async () => {
  const s = await setup();
  try {
    const other = run(s.spaces.create("other", process.cwd()));
    const win = run(other.newWindow());
    run(win.init("shell"));
    const blocked = await blockedAgent(win, "claude-detached");

    expect(blocked.viewers).toBe(0);
    expect(win.detached).toContain(blocked);

    expect(s.spaces.nextBlocked()).toBe(blocked);
    expect(blocked.viewers).toBe(1);
    expect(win.detached).not.toContain(blocked);
    expect(win.focused?.session).toBe(blocked);
    expect(s.spaces.active).toBe(other);
  } finally {
    await s.dispose();
  }
});

test("an agent with no view is detached but keeps running", async () => {
  const s = await setup();
  try {
    const bg = run(s.win.spawn("background", ["sleep", "30"]));
    expect(bg.viewers).toBe(0);
    expect(s.win.detached).toContain(bg);

    s.win.reveal(bg);
    expect(bg.viewers).toBe(1);
    expect(s.win.detached).not.toContain(bg);
  } finally {
    await s.dispose();
  }
});

test("output on a detached agent marks it unseen", async () => {
  const s = await setup();
  try {
    const chatter = run(
      s.win.spawn("chatter", ["sh", "-c", "echo hello-from-detached; sleep 5"]),
    );
    await Bun.sleep(400);
    expect(chatter.unseen).toBe(true);
    // Opening a view is what clears it.
    s.win.reveal(chatter);
    expect(chatter.unseen).toBe(false);
  } finally {
    await s.dispose();
  }
});

test("killing an agent removes it and leaves the others alone", async () => {
  const s = await setup();
  try {
    const killme = run(s.win.spawn("killme", ["sleep", "30"]));
    const keep = run(s.win.spawn("keep", ["sleep", "30"]));
    await runAsync(s.win.killSession(killme));
    expect(s.win.agents).not.toContain(killme);
    expect(s.win.agents).toContain(keep);
  } finally {
    await s.dispose();
  }
});

/**
 * ts-8d06b3: a killed agent is reported exactly as an exited one is.
 *
 * The app's cascade — window closes with its last agent, space with its last
 * window — hangs off this notification, so an unreported kill left an empty
 * window behind that you could still cycle to. The two paths have to raise the
 * same event or they drift apart again.
 */
test("killing an agent reports it the way an exit does", async () => {
  const s = await setup();
  try {
    const killme = run(s.win.spawn("killme", ["sleep", "30"]));
    const seen: { agent: Session; remaining: number }[] = [];
    s.space.onAgentExit = (agent, window) =>
      // Captured from inside the handler: the cascade decides what to do by
      // asking what is left, so the removal must already have happened.
      seen.push({ agent, remaining: window.agents.length });

    const before = s.win.agents.length;
    await runAsync(s.win.killSession(killme));

    expect(seen.map((s) => s.agent)).toEqual([killme]);
    expect(seen[0]!.remaining).toBe(before - 1);
  } finally {
    await s.dispose();
  }
});

test("scrolled reflects the real viewport, including past both edges", async () => {
  const s = await setup();
  try {
    // Real scrollback is required: `scrolled` is read back from ghostty's
    // viewport, so scrolling a terminal with no history is correctly a no-op.
    const bg = run(s.win.spawn("scrolly", ["sh", "-c", "seq 1 200; sleep 30"]));
    await Bun.sleep(400);
    expect(bg.scrolled).toBe(false);

    bg.scrollBy(-5);
    expect(bg.scrolled).toBe(true);
    bg.scrollToBottom();
    expect(bg.scrolled).toBe(false);

    bg.scrollBy(5); // down while already at the bottom: a no-op, not "scrolled"
    expect(bg.scrolled).toBe(false);

    // Past the top and all the way back. A locally tracked offset over-counts
    // here and never returns to the bottom; the viewport read-back stays honest.
    bg.scrollBy(-9999);
    expect(bg.scrolled).toBe(true);
    bg.scrollBy(9999);
    expect(bg.scrolled).toBe(false);
  } finally {
    await s.dispose();
  }
});

test("each space keeps its own windows and layouts across activation", async () => {
  const s = await setup();
  try {
    const other = run(s.spaces.create("other", process.cwd()));
    const otherWin = run(other.newWindow());
    run(otherWin.init("shell"));
    run(otherWin.splitSpawn("row"));
    expect(otherWin.panes.length).toBe(2);
    expect(s.win.panes.length).toBe(1);

    // Activating swaps the whole pane area over; the inactive space keeps its
    // windows, their split trees and their agents rather than being torn down.
    s.spaces.activate(other);
    expect(s.spaces.active).toBe(other);
    expect(s.win.panes.length).toBe(1);
    expect(s.win.agents.length).toBe(1);

    s.spaces.activate(s.space);
    expect(otherWin.panes.length).toBe(2);
    expect(otherWin.agents.length).toBe(2);
  } finally {
    await s.dispose();
  }
});

test("joining a pane preserves its live agent and transfers ownership", async () => {
  const s = await setup();
  try {
    const source = s.win;
    const pane = source.panes[0]!;
    const agent = pane.session;
    const destination = run(s.space.newWindow());
    run(destination.init("destination"));

    expect(await runAsync(s.space.joinPane(pane, source.number))).toBe(
      destination,
    );
    expect(source.panes).toHaveLength(0);
    expect(destination.panes).toContain(pane);
    expect(destination.agents).toContain(agent);
    expect(agent.exited).toBe(false);
    expect(s.space.windows).toEqual([destination]);

    await runAsync(s.space.closeWindow(destination));
    expect(s.space.windows).toHaveLength(0);
  } finally {
    await s.dispose();
  }
});

test("a space of plain shells is idle, and an exited one still reads as idle", async () => {
  // Shells have no agent state to report, so the space stays idle no matter
  // what they are running — see the note on Agent.state.
  const s = await setup();
  try {
    await Bun.sleep(300);
    expect(s.space.state).toBe("idle");

    const agent = s.win.agents[0]!;
    agent.write("sleep 5\n");
    await Bun.sleep(400);
    expect(agent.state).toBe("idle");
    expect(s.space.state).toBe("idle");
  } finally {
    await s.dispose();
  }
});

test("a roll-up reports the most urgent state present, and 'done' never wins", () => {
  const stub = (state: AgentState) => ({ state }) as unknown as Session;
  expect(rollUp([])).toBe("done");
  expect(rollUp([stub("idle"), stub("working"), stub("done")])).toBe("working");
  expect(rollUp([stub("working"), stub("blocked")])).toBe("blocked");
  expect(rollUp([stub("idle"), stub("detached")])).toBe("detached");
  // One finished agent must not make a space with live agents look finished.
  expect(rollUp([stub("done"), stub("idle")])).toBe("idle");
  expect(rollUp([stub("done"), stub("done")])).toBe("done");
});

test("a pane closes when its agent's process exits, and the agent stays as done", async () => {
  const s = await setup();
  try {
    const pane = s.win.split(
      "row",
      run(s.win.spawn("shortlived", ["sh", "-c", "echo bye; exit 0"])),
    );
    expect(pane).not.toBeNull();
    expect(s.win.panes.length).toBe(2);

    await Bun.sleep(600);
    // The view is gone so the layout reclaims the space...
    expect(s.win.panes.length).toBe(1);
    // ...but the agent is still listed, exited, with its output still readable.
    const agent = s.win.agents.find((a) => a.name === "shortlived");
    expect(agent).toBeDefined();
    expect(agent!.state).toBe("done");
    expect(s.win.detached).toContain(agent!);
  } finally {
    await s.dispose();
  }
});

test("a finished agent does not make its space look finished", async () => {
  const s = await setup();
  try {
    run(s.win.spawn("shortlived", ["sh", "-c", "exit 0"]));
    await Bun.sleep(500);
    // One agent is done, the seeded shell is still alive at its prompt.
    expect(s.win.agents.some((a) => a.state === "done")).toBe(true);
    expect(s.space.state).toBe("idle");
  } finally {
    await s.dispose();
  }
});

test("windows keep separate agents and layouts within one space", async () => {
  const s = await setup();
  try {
    run(s.win.spawn("alpha", ["sleep", "30"]));
    const second = run(s.space.newWindow("build"));
    run(second.init("shell"));
    run(second.splitSpawn("row"));

    expect(s.space.windows.length).toBe(2);
    expect(s.space.active).toBe(second);
    // Agents belong to the window they were started in, not to the space.
    expect(s.win.agents.length).toBe(2);
    expect(second.agents.length).toBe(2);
    expect(s.space.agents.length).toBe(4);
    // Switching back restores the first window's layout untouched.
    s.space.selectWindow(s.win);
    expect(s.win.panes.length).toBe(1);
    expect(second.panes.length).toBe(2);
  } finally {
    await s.dispose();
  }
});

test("windows are selectable by their stable number", async () => {
  const s = await setup();
  try {
    const second = run(s.space.newWindow());
    run(second.init("shell"));
    const third = run(s.space.newWindow());
    run(third.init("shell"));
    expect([s.win.number, second.number, third.number]).toEqual([1, 2, 3]);

    // Closing a middle window must not renumber the others, or ^a 3 would
    // start selecting a different window than it did a moment ago.
    await runAsync(s.space.closeWindow(second));
    expect(s.space.selectNumber(3)).toBe(true);
    expect(s.space.active).toBe(third);
    expect(s.space.selectNumber(2)).toBe(false);
  } finally {
    await s.dispose();
  }
});

test("closing a window stops the agents that live in it", async () => {
  const s = await setup();
  try {
    const second = run(s.space.newWindow());
    run(second.init("shell"));
    const doomed = run(second.spawn("doomed", ["sleep", "60"]));
    expect(doomed.exited).toBe(false);

    await runAsync(s.space.closeWindow(second));
    await Bun.sleep(300);
    expect(s.space.windows).not.toContain(second);
    expect(s.space.agents).not.toContain(doomed);
  } finally {
    await s.dispose();
  }
});

test("a window's title falls back to what it is running", async () => {
  const s = await setup();
  try {
    expect(s.win.title.length).toBeGreaterThan(0);
    s.win.customName = "editor";
    expect(s.win.title).toBe("editor");
    // Clearing the name hands it back to the running agent.
    s.win.customName = null;
    expect(s.win.title).not.toBe("editor");
  } finally {
    await s.dispose();
  }
});

test("splitting inserts a draggable divider that resizes its neighbours", async () => {
  const s = await setup();
  try {
    const pane = run(s.win.splitSpawn("row"));
    expect(pane).not.toBeNull();

    const children = s.win.root.getChildren();
    // pane, divider, pane — the divider is a real renderable, so OpenTUI's hit
    // grid resolves drags onto it without any rect math of ours.
    expect(children.length).toBe(3);
    const divider = children[1] as any;
    expect(divider.axis).toBe("row");
    expect(divider.width).toBe(1);

    await s.t.renderOnce();
    const [left, right] = [children[0] as any, children[2] as any];
    const total = left.width + right.width;
    const startX = divider.x;

    // Simulate a fast drag that jumps clear of the divider in one event: the
    // resize is computed from where the pointer is, not from accumulated
    // deltas, so overshooting still lands where asked.
    divider.onMouseEvent({
      type: "down",
      x: startX,
      y: divider.y,
      button: 0,
      stopPropagation() {},
    });
    divider.onMouseEvent({
      type: "drag",
      x: startX - 10,
      y: divider.y,
      button: 0,
      stopPropagation() {},
    });
    await s.t.renderOnce();

    expect(left.width).toBe(total - right.width);
    expect(left.width).toBeLessThan(total / 2);
  } finally {
    await s.dispose();
  }
});

test("a divider cannot be dragged past its neighbour", async () => {
  const s = await setup();
  try {
    run(s.win.splitSpawn("row"));
    const children = s.win.root.getChildren();
    const divider = children[1] as any;
    await s.t.renderOnce();
    const [left, right] = [children[0] as any, children[2] as any];
    const total = left.width + right.width;

    divider.onMouseEvent({
      type: "down",
      x: divider.x,
      y: divider.y,
      button: 0,
      stopPropagation() {},
    });
    divider.onMouseEvent({
      type: "drag",
      x: divider.x + 9999,
      y: divider.y,
      button: 0,
      stopPropagation() {},
    });
    await s.t.renderOnce();

    // The neighbour keeps a usable minimum rather than collapsing to nothing.
    expect(right.width).toBeGreaterThan(0);
    expect(left.width + right.width).toBe(total);
  } finally {
    await s.dispose();
  }
});

test("closing a pane takes its divider with it", async () => {
  const s = await setup();
  try {
    const pane = run(s.win.splitSpawn("row"))!;
    expect(s.win.root.getChildren().length).toBe(3);

    s.win.close(pane);
    // A leftover divider would render as a border against nothing.
    const children = s.win.root.getChildren();
    expect(children.length).toBe(1);
    expect(children[0]).toBe(s.win.panes[0]);
  } finally {
    await s.dispose();
  }
});

test("splitting a resized pane gives the newcomer half of it, not a sliver", async () => {
  const s = await setup();
  try {
    run(s.win.splitSpawn("row"));
    await s.t.renderOnce();
    const rootKids = () => s.win.root.getChildren() as any[];

    // Resize so the panes are lopsided, which is what exposed the bug: the
    // divider stores weights as cell counts, and a fresh pane used to arrive
    // weighted 1 against a neighbour weighted ~70.
    const divider = rootKids()[1];
    divider.onMouseEvent({
      type: "down",
      x: divider.x,
      y: divider.y,
      button: 0,
      stopPropagation() {},
    });
    divider.onMouseEvent({
      type: "drag",
      x: divider.x - 20,
      y: divider.y,
      button: 0,
      stopPropagation() {},
    });
    await s.t.renderOnce();
    const [leftBefore, , rightBefore] = rootKids().map((k) => k.width);

    run(s.win.splitSpawn("row"));
    await s.t.renderOnce();

    // Splitting along the axis the parent already runs on makes a SIBLING, not
    // a nested box: three panes in a row, tmux's arrangement after two
    // horizontal splits. The live tree used to nest here and its own export did
    // not — collapse() flattens a same-axis child — so a window saved and
    // restored changed shape. The model is the shape now.
    const widths = rootKids().map((k) => k.width);
    expect(rootKids()).toHaveLength(5);

    // The pane that was not split keeps its size...
    const [leftAfter, , splitAfter, , newcomer] = widths;
    expect(leftAfter).toBe(leftBefore);
    // ...and the new pane took half of the pane it split, not a cell or two.
    expect(splitAfter).toBeGreaterThan(rightBefore / 3);
    expect(newcomer).toBeGreaterThan(rightBefore / 3);
  } finally {
    await s.dispose();
  }
});

test("a pane draws only the edges facing the window, never one a divider covers", async () => {
  const s = await setup();
  try {
    // One pane owns the whole frame.
    const only = s.win.panes[0]!;
    expect(only.edges).toEqual({
      top: true,
      right: true,
      bottom: true,
      left: true,
    });

    // Split left/right: the seam between them belongs to the divider, so
    // neither pane draws a border there and the frame stays one cell thick.
    const right = run(s.win.splitSpawn("row"))!;
    const left = s.win.panes[0]!;
    expect(left.edges).toEqual({
      top: true,
      right: false,
      bottom: true,
      left: true,
    });
    expect(right.edges).toEqual({
      top: true,
      right: true,
      bottom: true,
      left: false,
    });

    // Split the right pane top/bottom. Its halves inherit the missing left
    // edge from the box that replaced it — the walk has to go up the tree, not
    // just look at immediate siblings.
    const bottom = run(s.win.splitSpawn("column"))!;
    expect(right.edges).toEqual({
      top: true,
      right: true,
      bottom: false,
      left: false,
    });
    expect(bottom.edges).toEqual({
      top: false,
      right: true,
      bottom: true,
      left: false,
    });

    // Closing the survivor's neighbour hands its edges back.
    s.win.close(bottom);
    expect(right.edges).toEqual({
      top: true,
      right: true,
      bottom: true,
      left: false,
    });
  } finally {
    await s.dispose();
  }
});

test("gap separates borders without widening the divider", async () => {
  const s = await setup();
  try {
    const right = run(s.win.splitSpawn("row"))!;
    const left = s.win.panes[0]!;
    const divider = s.win.root.getChildren()[1] as Divider;

    // Gap off is the merged-border mode: the divider owns the shared seam.
    expect(divider.width).toBe(1);
    expect(left.edges.right).toBe(false);
    expect(right.edges.left).toBe(false);

    applyOptions(resolveOptions({ "appearance.gap": true }));
    s.win.refreshChrome();

    // Gap restores both pane borders while keeping the divider one cell wide.
    expect(divider.width).toBe(1);
    expect(left.edges.right).toBe(true);
    expect(right.edges.left).toBe(true);
  } finally {
    applyOptions(resolveOptions({}));
    s.win.refreshChrome();
    await s.dispose();
  }
});

test("gap separates columns without adding a blank row", async () => {
  const s = await setup();
  try {
    run(s.win.splitSpawn("column"));
    const divider = s.win.root.getChildren()[1] as Divider;

    applyOptions(resolveOptions({ "appearance.gap": true }));
    s.win.refreshChrome();
    await s.t.renderOnce();

    expect(divider.height).toBe(1);
    const panes = [...s.win.panes].sort((a, b) => a.y - b.y);
    expect(panes[1]!.y).toBe(panes[0]!.y + panes[0]!.height);
  } finally {
    applyOptions(resolveOptions({}));
    s.win.refreshChrome();
    await s.dispose();
  }
});

test("outer border can be hidden in gap mode", async () => {
  const s = await setup();
  try {
    applyOptions(resolveOptions({ "appearance.outerBorder": false }));
    s.win.refreshChrome();
    expect(s.win.panes[0]!.edges).toEqual({
      top: false,
      right: false,
      bottom: false,
      left: false,
    });

    applyOptions(
      resolveOptions({
        "appearance.gap": true,
        "appearance.outerBorder": false,
      }),
    );
    s.win.refreshChrome();
    expect(s.win.panes[0]!.edges).toEqual({
      top: true,
      right: true,
      bottom: true,
      left: true,
    });

    run(s.win.splitSpawn("row"));
    expect(
      s.win.panes.every((pane) => pane.edges.top && pane.edges.bottom),
    ).toBe(true);
    expect(
      s.win.panes.every((pane) => pane.edges.left || pane.edges.right),
    ).toBe(true);
  } finally {
    applyOptions(resolveOptions({}));
    s.win.refreshChrome();
    await s.dispose();
  }
});

test("gap gives each pane a complete border and remains draggable", async () => {
  const s = await setup();
  applyOptions(resolveOptions({ "appearance.gap": true }));
  try {
    run(s.win.splitSpawn("row"));
    await s.t.renderOnce();
    const children = s.win.root.getChildren() as any[];
    const [left, divider, right] = children;
    expect(divider.width).toBe(1);
    expect(left.edges).toEqual({
      top: true,
      right: true,
      bottom: true,
      left: true,
    });
    expect(right.edges).toEqual({
      top: true,
      right: true,
      bottom: true,
      left: true,
    });
    expect(left.x + left.width).toBe(divider.x);
    expect(divider.x + divider.width).toBe(right.x);
    const total = left.width + right.width;
    divider.onMouseEvent({
      type: "down",
      x: divider.x,
      y: divider.y,
      button: 0,
      stopPropagation() {},
    });
    divider.onMouseEvent({
      type: "drag",
      x: divider.x - 5,
      y: divider.y,
      button: 0,
      stopPropagation() {},
    });
    await s.t.renderOnce();
    expect(left.width + right.width).toBe(total);
    expect(left.width).toBeLessThan(total / 2);
  } finally {
    applyOptions(resolveOptions({}));
    s.win.refreshChrome();
    await s.dispose();
  }
});

test("a divider caps its ends against the frame and tees into other dividers", async () => {
  const s = await setup();
  try {
    run(s.win.splitSpawn("row"));
    const vertical = s.win.root.getChildren()[1] as Divider;
    // Runs the full height of the window, so both ends meet the outer border.
    expect([vertical.capStart, vertical.capEnd]).toEqual([true, true]);

    // A horizontal split of the right-hand pane sits inside it: its left end
    // runs into the vertical divider rather than the frame.
    run(s.win.splitSpawn("column"));
    const box = s.win.root.getChildren()[2] as BoxRenderable;
    const horizontal = box.getChildren()[1] as Divider;
    expect(horizontal.axis).toBe("column");
    expect([horizontal.capStart, horizontal.capEnd]).toEqual([false, true]);
  } finally {
    await s.dispose();
  }
});

test("the focused pane's shared border highlights with it", async () => {
  const s = await setup();
  try {
    const right = run(s.win.splitSpawn("row"))!;
    const divider = s.win.root.getChildren()[1] as Divider;
    // The seam is the focused pane's border too, so it lights up with it.
    expect(divider.adjacentToFocus).toBe(true);

    // Still adjacent from the other side.
    s.win.focus(s.win.panes[0]!);
    expect(divider.adjacentToFocus).toBe(true);

    // Focus a pane in a nested box: the divider two levels up is no longer
    // touching the focused pane directly, but it still bounds the subtree.
    s.win.focus(right);
    const deep = run(s.win.splitSpawn("column"))!;
    expect(divider.adjacentToFocus).toBe(true);
    const inner = (
      s.win.root.getChildren()[2] as BoxRenderable
    ).getChildren()[1] as Divider;
    expect(inner.adjacentToFocus).toBe(true);
    expect(deep.edges.left).toBe(false);
  } finally {
    await s.dispose();
  }
});

test("selectLastWindow toggles between the two most recent windows", async () => {
  const s = await setup();
  try {
    const second = run(s.space.newWindow());
    run(second.init("shell"));
    const third = run(s.space.newWindow());
    run(third.init("shell"));
    // newWindow selects what it creates: active is third, last is second.
    s.space.selectWindow(s.win);
    s.space.selectWindow(third);
    expect(s.space.active).toBe(third);

    s.space.selectLastWindow();
    expect(s.space.active).toBe(s.win);
    s.space.selectLastWindow();
    expect(s.space.active).toBe(third);
  } finally {
    await s.dispose();
  }
});

test("a closed last window is skipped, not selected", async () => {
  const s = await setup();
  try {
    const second = run(s.space.newWindow());
    run(second.init("shell"));
    const third = run(s.space.newWindow());
    run(third.init("shell"));

    s.space.selectWindow(s.win);
    s.space.selectWindow(third);
    s.space.selectWindow(second);
    expect(s.space.active).toBe(second);

    await runAsync(s.space.closeWindow(third));
    // Closing an unrelated window leaves the active one alone...
    expect(s.space.active).toBe(second);
    // ...but the pair's other endpoint is gone, so the toggle has nothing to do.
    s.space.selectLastWindow();
    expect(s.space.active).toBe(second);
  } finally {
    await s.dispose();
  }
});

test("closing the active window lands on the last window and clears the pair", async () => {
  const s = await setup();
  try {
    const second = run(s.space.newWindow());
    run(second.init("shell"));
    // second is active and s.win is last — the pair that closing second
    // collapses into a single window.
    await runAsync(s.space.closeWindow(second));
    expect(s.space.active).toBe(s.win);

    // The toggle's other endpoint was the window that died; there is nothing
    // to toggle to until a new pair forms.
    s.space.selectLastWindow();
    expect(s.space.active).toBe(s.win);
  } finally {
    await s.dispose();
  }
});

test("closing the active window falls back to a neighbour when there is no last", async () => {
  const s = await setup();
  try {
    const second = run(s.space.newWindow());
    run(second.init("shell"));
    const third = run(s.space.newWindow());
    run(third.init("shell"));
    // active = third, last = second. Closing the LAST clears it; closing the
    // ACTIVE then has no last to land on and picks the neighbour instead.
    await runAsync(s.space.closeWindow(second));
    expect(s.space.active).toBe(third);
    await runAsync(s.space.closeWindow(third));
    expect(s.space.active).toBe(s.win);
  } finally {
    await s.dispose();
  }
});
