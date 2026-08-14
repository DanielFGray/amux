/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { run, runAsync, scopedSpaceSet } from "./harness.ts";
import { workspaceEnv } from "./env.ts";
import { frame } from "./window.ts";
import { computeRects } from "./geometry.ts";
import { ComponentPane, type PaneView } from "./component-pane.tsx";
import { createSessionViews } from "./plugin/session-views.tsx";
import { TerminalPane, type Pane } from "./pane.ts";
import { makeLayout, newPaneId, type PaneContent } from "./layout.ts";
import type { KeyEvent } from "@opentui/core";

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
const label: PaneView = (props) => <text>view:{props.sessionId}</text>;

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
  expect(rows[1]!.slice(1)).toStartWith(`view:${chat.id}`);
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

test("a sessionless plugin pane mounts the registered view from its descriptor", async () => {
  const { t, win } = await workspace((props) => (
    <text>session:{props.sessionId}|file:{JSON.stringify(props.descriptor)}</text>
  ));
  const editor: PaneContent = {
    kind: "plugin",
    type: "amux.editor",
    descriptor: { file: "/note.txt" },
  };
  const id = newPaneId();
  expect(
    win.applyLayout(makeLayout({ root: { type: "pane", id, content: editor, weight: 1 }, focus: id })),
  ).toBe(true);

  const pane = win.panes.find((candidate) => candidate.id === id)!;
  // A backend-less view: a component leaf, owning no session to resize or write
  // to, and surviving the window's own layout round trip.
  expect(pane).toBeInstanceOf(ComponentPane);
  expect(pane.session).toBeNull();
  expect(win.exportLayout().floats).toHaveLength(0);

  await draw(t);
  const frame = t.captureCharFrame();
  // No session id and the descriptor verbatim — the view was mounted from the
  // content alone.
  expect(frame).toContain(`session:|file:{"file":"/note.txt"}`);
  expect(win.focused).toBe(pane);
});

test("a mounted component pane reacts when its harness view is registered and removed", async () => {
  const views = createSessionViews();
  const { t, win } = await workspace(views.view);
  const chat = run(win.startSession(componentSession("chat")));
  win.mount(chat);
  await draw(t);
  expect(t.captureCharFrame()).toContain("Pane type 'native' is unavailable.");

  const dispose = views.register("native", () => <text>native harness</text>);
  await draw(t);
  expect(t.captureCharFrame()).toContain("native harness");

  dispose();
  await draw(t);
  expect(t.captureCharFrame()).toContain("Pane type 'native' is unavailable.");
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
  expect(win.panes).toHaveLength(2);
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
  expect(t.captureCharFrame()).toContain(`view:${chat.id}`);
});

test("closing a component leaf disposes its subtree", async () => {
  const { t, win } = await workspace();
  const chat = run(win.startSession(componentSession("chat")));
  const pane = win.mount(chat);
  await draw(t);
  expect(t.captureCharFrame()).toContain(`view:${chat.id}`);

  pane.destroyRecursively();
  await draw(t);

  expect(t.captureCharFrame()).not.toContain(`view:${chat.id}`);
});

/** Enough of a keystroke for the encoder: the raw bytes the outer terminal
 *  produced, which is all a pass-through needs. */
const keystroke = (raw: string) => ({ raw, sequence: raw, eventType: "press" }) as KeyEvent;

/** The pane less only the sides it actually draws. A pane facing a split does
 *  not own that border — the divider between them does. */
const inner = (pane: Pane) => pane.width - (pane.edges.left ? 1 : 0) - (pane.edges.right ? 1 : 0);

test("an unbound key is bytes to a terminal leaf and untouched by a component one", async () => {
  const { win } = await workspace();
  const chat = run(win.startSession(componentSession("chat")));
  const shell = run(win.startSession({ name: "shell", cmd: ["true"], exited: { code: 0 } }));
  const chatPane = win.mount(chat);
  const shellPane = win.split("row", shell)!;

  const written: string[] = [];
  shellPane.session!.write = (data) => {
    written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  };

  win.focus(shellPane);
  expect(win.key(keystroke("h"))).toBe(true);
  expect(written).toEqual(["h"]);

  // False, and nothing written: the key belongs to whichever renderable inside
  // the subtree holds focus, and consuming it here would stop it ever arriving.
  win.focus(chatPane);
  expect(win.key(keystroke("h"))).toBe(false);
  expect(written).toEqual(["h"]);
});

test("a component's view sees the frame move under it", async () => {
  let mounts = 0;
  const probe: PaneView = (props) => {
    mounts++;
    return <text>{`w=${props.width()} active=${props.active()}`}</text>;
  };
  const { t, win } = await workspace(probe);
  const chat = run(win.startSession(componentSession("chat")));
  const shell = run(win.startSession({ name: "shell", cmd: ["true"], exited: { code: 0 } }));
  const chatPane = win.mount(chat);
  await draw(t);

  const full = inner(chatPane);
  expect(t.captureCharFrame()).toContain(`w=${full} active=true`);

  // A split narrows the pane; the composer inside it has to be told, or it
  // wraps its text to a width the pane no longer has.
  const shellPane = win.split("row", shell)!;
  await draw(t);
  expect(inner(chatPane)).toBeLessThan(full);
  expect(t.captureCharFrame()).toContain(`w=${inner(chatPane)} active=false`);

  win.focus(chatPane);
  await draw(t);
  expect(t.captureCharFrame()).toContain("active=true");
  expect(shellPane.active).toBe(false);

  // The view function ran once: a resize and a focus change are signal updates,
  // not a remount, which is what lets a composer keep a half-typed message.
  expect(mounts).toBe(1);
});

test("killing the session behind a component leaf closes its pane", async () => {
  const { win } = await workspace();
  const chat = run(win.startSession(componentSession("chat")));
  const pane = win.mount(chat);

  await runAsync(win.killSession(chat));

  expect(win.panes).toHaveLength(0);
  expect(pane.isDestroyed).toBe(true);
});
