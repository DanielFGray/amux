/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { run, runAsync, scopedSpaceSet } from "./harness.ts";
import { workspaceEnv } from "./env.ts";
import { frame } from "./window.ts";
import { computeRects } from "./geometry.ts";
import { ComponentPane, type PaneView } from "./component-pane.tsx";
import { TerminalPane } from "./pane.ts";
import type { Session } from "./agent.ts";

/**
 * The component leaf: a pane whose content is a Solid subtree.
 *
 * What these check is that being a component changes only what fills the frame.
 * Everything a window does to a leaf — tile it, split it, focus it, take it
 * apart and put it back — has to work identically, because a component leaf
 * that needed its own path through any of that would not be a pane.
 */

const WIDTH = 40;
const HEIGHT = 12;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  frame.externalLeft = false;
});

/** Two passes, because the first is what gives a freshly built pane its size
 *  and the content box only reaches that size on the pass after. */
const draw = async (t: { renderOnce: () => Promise<void> }) => {
  await t.renderOnce();
  await t.renderOnce();
};

/** A view that names the session it was given, so a check can tell mounted
 *  content from an empty frame and can tell the two panes apart. */
const label: PaneView = (session: Session) => <text>view:{session.name}</text>;

/** `null` registers no view at all — the default parameter would swallow an
 *  `undefined` and quietly test the opposite of what that case is about. */
async function workspace(view: PaneView | null = label) {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const host = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
  t.renderer.root.add(host);
  const { spaces, dispose } = scopedSpaceSet(
    workspaceEnv(t.renderer, { paneContent: view ?? undefined }),
    host,
  );
  cleanup.push(() => {
    void dispose();
    t.renderer.destroy();
  });
  const space = run(spaces.create("proj", process.cwd()));
  const win = run(space.newWindow());
  return { t, spaces, space, win };
}

/** A component session that runs nothing: the substrate under test is what
 *  draws it, and a worker process would only add a race to every check. */
const componentSession = (name: string) => ({
  name,
  kind: "component" as const,
  agent: "native",
  cmd: ["true"],
  exited: { code: 0 },
});

test("a component session gets a component leaf and a pty session gets a terminal one", async () => {
  const { win } = await workspace();
  const chat = run(win.startSession(componentSession("chat")));
  const shell = run(win.startSession({ name: "shell", cmd: ["true"], exited: { code: 0 } }));

  expect(win.mount(chat)).toBeInstanceOf(ComponentPane);
  expect(win.split("row", shell)).toBeInstanceOf(TerminalPane);
});

test("the registered view is mounted inside the pane's border", async () => {
  const { t, win } = await workspace();
  const chat = run(win.startSession(componentSession("chat")));
  win.mount(chat);
  await draw(t);

  const rows = t.captureCharFrame().split("\n");
  // Row 0 is the pane's own top border, so the view starts on row 1, one column
  // in from the left border.
  expect(rows[0]!.startsWith("┌")).toBe(true);
  expect(rows[1]!.slice(1)).toStartWith("view:chat");
});

test("a workspace that registered no view draws the frame and nothing in it", async () => {
  const { t, win } = await workspace(null);
  const chat = run(win.startSession(componentSession("chat")));
  win.mount(chat);
  await draw(t);

  const rows = t.captureCharFrame().split("\n");
  expect(rows[0]!.startsWith("┌")).toBe(true);
  expect(rows[1]).not.toContain("view:");
});

test("a component leaf tiles as the exact rectangle the layout model says", async () => {
  const { t, win } = await workspace();
  const chat = run(win.startSession(componentSession("chat")));
  const shell = run(win.startSession({ name: "shell", cmd: ["true"], exited: { code: 0 } }));
  win.mount(chat);
  win.split("row", shell);
  await draw(t);

  // The same fixed point geometry.test.ts holds terminal panes to: opentui's
  // flex result and the model's arithmetic must agree, or a component leaf is
  // in a different place than every command that addresses it believes.
  const expected = computeRects(win.exportLayout(), {
    cols: win.root.width,
    rows: win.root.height,
  });
  for (const pane of win.panes) {
    expect(expected.get(pane.id)).toEqual({
      x: pane.x - win.root.x,
      y: pane.y - win.root.y,
      width: pane.width,
      height: pane.height,
    });
  }
});

test("a component leaf splits, focuses and closes like any other pane", async () => {
  const { t, win } = await workspace();
  const chat = run(win.startSession(componentSession("chat")));
  const shell = run(win.startSession({ name: "shell", cmd: ["true"], exited: { code: 0 } }));
  const chatPane = win.mount(chat);
  const shellPane = win.split("row", shell)!;
  await draw(t);

  expect(win.panes).toHaveLength(2);
  expect(win.focused).toBe(shellPane);

  win.focus(chatPane);
  expect(win.focused).toBe(chatPane);
  expect(chatPane.active).toBe(true);
  expect(shellPane.active).toBe(false);

  win.close(chatPane);
  expect(chatPane.isDestroyed).toBe(true);
  expect(win.panes).toEqual([shellPane]);
});

test("a component leaf survives a rebuild rather than being remounted", async () => {
  const { t, win } = await workspace();
  const chat = run(win.startSession(componentSession("chat")));
  const shell = run(win.startSession({ name: "shell", cmd: ["true"], exited: { code: 0 } }));
  const chatPane = win.mount(chat);
  win.split("row", shell);
  await draw(t);

  // Every reshape takes the tree apart and puts it back. A leaf whose content
  // is a live reactive subtree must be REUSED across that, not rebuilt: a
  // remount would silently drop whatever state the view was holding.
  win.selectLayout("even-vertical");
  await draw(t);

  expect(win.panes).toContain(chatPane);
  expect(chatPane.isDestroyed).toBe(false);
  expect(t.captureCharFrame()).toContain("view:chat");
});

test("closing a component leaf disposes its subtree", async () => {
  const { t, win } = await workspace();
  const chat = run(win.startSession(componentSession("chat")));
  const pane = win.mount(chat);
  await draw(t);
  expect(t.captureCharFrame()).toContain("view:chat");

  pane.destroyRecursively();
  await draw(t);

  expect(t.captureCharFrame()).not.toContain("view:chat");
});

test("killing the session behind a component leaf closes its pane", async () => {
  const { win } = await workspace();
  const chat = run(win.startSession(componentSession("chat")));
  const pane = win.mount(chat);

  await runAsync(win.killSession(chat));

  expect(win.panes).toHaveLength(0);
  expect(pane.isDestroyed).toBe(true);
});
