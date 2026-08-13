import { test, expect } from "bun:test";
import { Divider } from "./divider.ts";
import { createHarness, run, runAsync } from "./harness.ts";
import type { Window } from "./window.ts";
import type { SessionHandle } from "./session-handle.ts";
import type { TerminalPane } from "./pane.ts";
import { RenderState } from "./ghostty.ts";
import { waitFor } from "./test-wait.ts";

const SHELL = ["bash"];

/** These assert the domain, so no view is mounted beyond the split trees the
 *  windows build. `win` rather than `window` throughout, which is why the
 *  shared harness is aliased rather than destructured. */
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

/** The agent's on-screen text, so a move's effect on terminal state is read
 *  from the terminal itself rather than from our bookkeeping. */
function screenTail(agent: SessionHandle): string {
  const state = new RenderState();
  state.update(agent.term);
  const text = state.tailText(8).join("\n");
  state.free();
  return text;
}

test("break moves the pane and its running agent into a new window, unchanged", async () => {
  const s = await setup();
  try {
    const right = run(s.win.splitSpawn("row"))!;
    const agent = right.session;
    agent.write("echo breakpane-marker-42\n");
    await waitFor(() => screenTail(agent).includes("breakpane-marker-42"), "pane output");
    expect(screenTail(agent)).toContain("breakpane-marker-42");

    const win2 = (await runAsync(s.space.breakPane(right)))!;

    // The same Agent — same process, same PTY, same terminal — not a relaunch.
    expect(win2.panes).toEqual([right]);
    expect(right.session).toBe(agent);
    expect(agent.exited).toBe(false);
    expect(screenTail(agent)).toContain("breakpane-marker-42");

    // Ownership moved: the source window no longer lists it, the new window
    // does, and the window took a fresh number.
    expect(s.win.panes).not.toContain(right);
    expect(s.win.sessions).not.toContain(agent);
    expect(win2.sessions).toEqual([agent]);
    expect(win2.number).toBeGreaterThan(s.win.number);

    // Focus followed the pane, tmux's session_select after a break.
    expect(s.space.active).toBe(win2);
    expect(win2.focused).toBe(right);
    // The label still says what the pane is running, but under the fresh number.
    expect(win2.label).not.toBe(s.win.label);
    expect(win2.label.startsWith(`${win2.number}:`)).toBe(true);

    // The moved pane fills its new window.
    await s.t.renderOnce();
    expect(right.width).toBe(win2.root.width);
    expect(right.height).toBe(win2.root.height);
  } finally {
    await s.dispose();
  }
});

test("break collapses the source layout: dividers and empty boxes go", async () => {
  const s = await setup();
  try {
    const left = s.win.panes[0]!;
    const right = run(s.win.splitSpawn("row"))!;
    const bottomRight = run(s.win.splitSpawn("column"))!; // splits right into a nested box
    expect(s.win.panes).toHaveLength(3);

    await runAsync(s.space.breakPane(bottomRight));

    // The nested box collapsed back into the root: pane, divider, pane.
    const kids = s.win.root.getChildren();
    expect(kids).toHaveLength(3);
    expect(kids[0]).toBe(left);
    expect(kids[1]).toBeInstanceOf(Divider);
    expect(kids[2]).toBe(right);
    expect(s.win.panes).toEqual([left, right]);

    // The seam is now between left and right, not a leftover from the removed
    // split — no pane is left drawing an edge nothing sits behind.
    expect(left.edges.right).toBe(false);
    expect(right.edges.left).toBe(false);

    // Remounting the source window, the survivors still fill it exactly.
    s.space.selectWindow(s.win);
    await s.t.renderOnce();
    expect(left.width + right.width + 1).toBe(s.win.root.width);
    expect(left.width).toBeGreaterThan(0);
    expect(right.width).toBeGreaterThan(0);
  } finally {
    await s.dispose();
  }
});

test("breaking the only pane closes the emptied source window", async () => {
  const s = await setup();
  try {
    const pane = s.win.panes[0]!;
    const win2 = (await runAsync(s.space.breakPane(pane)))!;

    expect(s.space.windows).not.toContain(s.win);
    expect(s.space.windows).toEqual([win2]);
    expect(win2.panes).toEqual([pane]);
    expect(s.space.active).toBe(win2);
  } finally {
    await s.dispose();
  }
});

test("a detached agent left in the source window survives the break", async () => {
  const s = await setup();
  try {
    const sleepy = run(s.win.spawn("background", ["sleep", "30"]));
    const pane = s.win.panes[0]!;

    const win2 = (await runAsync(s.space.breakPane(pane)))!;

    // The window kept its detached, still-running agent instead of closing.
    expect(s.space.windows).toContain(s.win);
    expect(s.win.panes).toHaveLength(0);
    expect(s.win.sessions).toContain(sleepy);
    expect(sleepy.exited).toBe(false);
    expect(win2.panes).toEqual([pane]);
  } finally {
    await s.dispose();
  }
});

test("a moved agent's exit closes its pane in the NEW window and reports it", async () => {
  const s = await setup();
  try {
    const exits: { agent: SessionHandle; window: Window }[] = [];
    s.space.onSessionExit = (agent, window) => {
      exits.push({ agent, window });
    };

    run(s.win.splitSpawn("row")); // stays behind in the source window
    // Held open on a read until the move is done: the claim under test is
    // where the exit is REPORTED, so the exit must not be allowed to race the
    // break. Releasing it explicitly is what makes the order a fact.
    const pane = s.win.split(
      "row",
      run(s.win.spawn("shortlived", ["sh", "-c", "read _; echo bye"])),
    )!;
    const win2 = (await runAsync(s.space.breakPane(pane)))!;
    const agent = pane.session;
    agent.write("\n");

    await waitFor(() => exits.length === 1, "the moved agent to exit");
    expect(exits).toHaveLength(1);
    // Ownership moved, so the exit landed on the new window, not the source.
    expect(exits[0]!.window).toBe(win2);
    expect(win2.panes).toHaveLength(0);
    expect(s.win.panes).toHaveLength(2);
    // The agent stays listed where it now lives, exited, output readable.
    expect(win2.sessions).toContain(agent);
    expect(agent.state).toBe("done");
  } finally {
    await s.dispose();
  }
});

test("break drops a zoom before moving the pane", async () => {
  const s = await setup();
  try {
    const a = s.win.panes[0]!;
    const b = run(s.win.splitSpawn("row"))!;
    s.win.focus(a);
    s.win.zoom();
    expect(s.win.zoomed).toBe(true);

    const win2 = (await runAsync(s.space.breakPane(a)))!;

    expect(s.win.zoomed).toBe(false);
    expect(s.win.panes).toEqual([b]);
    expect(win2.panes).toEqual([a]);

    // The surviving pane is back on the root, not parked by the zoom.
    s.space.selectWindow(s.win);
    await s.t.renderOnce();
    expect(b.width).toBeGreaterThan(0);
    expect(b.width).toBe(s.win.root.width);
  } finally {
    await s.dispose();
  }
});

// break-pane always adopts into a window it just made, so this exercises adopt
// directly. It is the destination half of the same rule the test above holds
// for the source, and joinp (moving a pane into an EXISTING window) is what
// will reach it through the app.
test("adopting into a zoomed window puts the hidden panes back on screen", async () => {
  const s = await setup();
  try {
    const a = s.win.panes[0]!;
    const b = run(s.win.splitSpawn("row"))!;
    s.win.focus(a);
    s.win.zoom();
    expect(s.win.zoomed).toBe(true);

    // A live pane from somewhere else, detached from its own window.
    const other = (await runAsync(s.space.newWindow()))!;
    const moved = run(other.init())!;
    expect(other.detachPane(moved)).toBe(moved);
    const scope = other.relinquishSession(moved.session)!;

    s.win.adopt(moved.session, moved, scope);

    // The newcomer is hung straight off the root, so the zoom has to come down
    // with it — otherwise a and b would be left unmounted with no arrangement
    // on screen to rejoin.
    expect(s.win.zoomed).toBe(false);
    expect(s.win.panes).toEqual([a, b, moved]);
    s.space.selectWindow(s.win);
    await s.t.renderOnce();
    for (const pane of s.win.panes) expect(pane.width).toBeGreaterThan(0);
  } finally {
    await s.dispose();
  }
});

test("a broken-out pane answers to its new window, not the old one", async () => {
  const s = await setup();
  try {
    const left = s.win.panes[0]!;
    const right = run(s.win.splitSpawn("row"))!;
    s.win.focus(left);

    const win2 = (await runAsync(s.space.breakPane(right)))!;

    // The pane came over focused; a click must route to its new window.
    expect(win2.focused).toBe(right);
    // Give the new window somewhere else to focus, then prove the pane
    // answers to win2 (focus moves, clicks land) while the source window
    // kept its own focus untouched. split already hands focus to the new
    // pane, so the "somewhere else" is simply the split it just made.
    run(win2.splitSpawn("row"));
    expect(win2.focused).not.toBe(right);
    right.onFocusRequest!(right);
    expect(win2.focused).toBe(right);
    expect(s.win.focused).toBe(left);
  } finally {
    await s.dispose();
  }
});

test("break updates what the sidebar and the tab list would show", async () => {
  const s = await setup();
  try {
    const right = run(s.win.splitSpawn("row"))!;
    const agent = right.session;

    const win2 = (await runAsync(s.space.breakPane(right)))!;

    const agentWindow = s.space.windows.find((window) => window.sessions.includes(agent));
    expect(agentWindow).toBe(win2);
    // The agent now hangs under the new window, not the source one.
    expect(agentWindow!.sessions).toContain(agent);
    expect(s.win.sessions).not.toContain(agent);

    // Tabs render from window.label; the new window carries a fresh number and
    // is the one on screen.
    const labels = s.space.windows.map((w) => w.label);
    expect(labels.some((l) => l.startsWith(`${agentWindow!.number}:`))).toBe(true);
    expect(s.space.active).toBe(agentWindow!);
  } finally {
    await s.dispose();
  }
});

test("breakPane refuses a pane that is not in this space", async () => {
  const s = await setup();
  try {
    const other = run(s.spaces.create("other", process.cwd()));
    const otherWin = run(other.newWindow());
    run(otherWin.init("shell"));

    expect(await runAsync(s.space.breakPane(otherWin.panes[0] as TerminalPane))).toBeNull();
    expect(s.space.windows).toEqual([s.win]);
  } finally {
    await s.dispose();
  }
});
