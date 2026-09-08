/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/** @jsxImportSource @opentui/solid */
import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { computeRects } from "./geometry.ts";
import { ComponentPane, type PaneView } from "./component-pane.tsx";
import { createSessionViews } from "./plugin/session-views.tsx";
import { testContributor } from "./plugin/test-contributor.ts";
import { TerminalPane, type Pane } from "./pane.ts";
import { makeLayout, type PaneContent, type Layout } from "./layout.ts";
import { project, snapshotOf, type Scene, type ProjectOptions, type SessionSpec } from "./harness.ts";
import { projectWorkspace } from "./space.ts";
import { testEffect } from "./test-effect.ts";
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

const { live } = testEffect(Layer.empty);

/** Two passes, because the first is what gives a freshly built pane its size
 *  and the content box only reaches that size on the pass after. */
function draw(scene: Scene) {
  return Effect.gen(function* () {
    yield* scene.renderOnce();
    yield* scene.renderOnce();
  });
}

/** A view that names the session it was given, so a check can tell mounted
 *  content from an empty frame and can tell the two panes apart. */
const label: PaneView = (props) => <text>view:{props.sessionId}</text>;

const ptyContent = (session: string): PaneContent => ({ kind: "pty", session });
const pluginContent = (session: string): PaneContent => ({
  kind: "plugin",
  type: "native",
  descriptor: {},
  session,
});

/** The spec for a component session that runs nothing. */
const componentSpec: SessionSpec = { kind: "component", declaredAgent: "native", cmd: ["true"] };
/** An override that keeps a session on the tombstone default (a pty that ended). */
const ptySpec: SessionSpec = {};
const componentSessions = (shell: boolean): Record<string, SessionSpec> =>
  shell ? { chat: componentSpec, shell: ptySpec } : { chat: componentSpec };

/** Mount `view` for a window holding one component session (`chat`) plus any
 *  extra sessions named in `extra`. */
function workspace(
  view: PaneView | null = label,
  layout: Layout = makeLayout({
    root: { type: "pane", id: "chat-pane", content: pluginContent("chat"), weight: 1 },
    focus: "chat-pane",
  }),
  sessions: ProjectOptions["sessions"] = {},
) {
  return Effect.gen(function* () {
    return yield* project(layout, {
      width: WIDTH,
      height: HEIGHT,
      paneContent: view ?? undefined,
      sessions: { chat: componentSpec, ...sessions },
    });
  });
}

live("a component session gets a component leaf and a pty session gets a terminal one", () =>
  Effect.gen(function* () {
    const scene = yield* workspace(label, makeLayout({
      root: {
        type: "split",
        direction: "row",
        weight: 1,
        children: [
          { type: "pane", id: "chat-pane", content: pluginContent("chat"), weight: 1 },
          { type: "pane", id: "shell-pane", content: ptyContent("shell"), weight: 1 },
        ],
      },
      focus: "shell-pane",
    }), { shell: {} });

    expect(scene.window.panes.find((p) => p.id === "chat-pane")).toBeInstanceOf(ComponentPane);
    expect(scene.window.panes.find((p) => p.id === "shell-pane")).toBeInstanceOf(TerminalPane);
  }),
);

live("the registered view is mounted inside the pane's border", () =>
  Effect.gen(function* () {
    const scene = yield* workspace();
    yield* draw(scene);

    const rows = scene.t.captureCharFrame().split("\n");
    // Row 0 is the pane's own top border, so the view starts on row 1, one column
    // in from the left border.
    expect(rows[0]!.startsWith("┌")).toBe(true);
    expect(rows[1]!.slice(1)).toStartWith("view:chat");
  }),
);

live("a workspace that registered no view draws the frame and nothing in it", () =>
  Effect.gen(function* () {
    const scene = yield* workspace(null);
    yield* draw(scene);

    const rows = scene.t.captureCharFrame().split("\n");
    expect(rows[0]!.startsWith("┌")).toBe(true);
    expect(rows[1]).not.toContain("view:");
  }),
);

live("a sessionless plugin pane mounts the registered view from its descriptor", () =>
  Effect.gen(function* () {
    const scene = yield* workspace((props) => (
      <text>
        session:{props.sessionId}|file:{JSON.stringify(props.descriptor)}
      </text>
    ), makeLayout({
      root: { type: "pane", id: "editor-pane", content: {
          kind: "plugin",
          type: "amux.editor",
          descriptor: { file: "/note.txt" },
        }, weight: 1 },
      focus: "editor-pane",
    }));

    const pane = scene.window.panes.find((candidate) => candidate.id === "editor-pane")!;
    // A backend-less view: a component leaf, owning no session to resize or write
    // to, and surviving the window's own layout round trip.
    expect(pane).toBeInstanceOf(ComponentPane);
    expect(pane.session).toBeNull();

    yield* draw(scene);
    const frameOut = scene.t.captureCharFrame();
    // No session id and the descriptor verbatim — the view was mounted from the
    // content alone.
    expect(frameOut).toContain(`session:|file:{"file":"/note.txt"}`);
    expect(scene.window.focused).toBe(pane);
  }),
);

live("a mounted component pane reacts when its harness view is registered and removed", () =>
  Effect.gen(function* () {
    const { contributions, owner } = testContributor();
    const views = createSessionViews(contributions);
    const scene = yield* workspace(views.view);
    yield* draw(scene);
    expect(scene.t.captureCharFrame()).toContain("Pane type 'native' is unavailable.");

    const dispose = views.register(owner, "native", () => <text>native harness</text>);
    yield* draw(scene);
    expect(scene.t.captureCharFrame()).toContain("native harness");

    dispose();
    yield* draw(scene);
    expect(scene.t.captureCharFrame()).toContain("Pane type 'native' is unavailable.");
  }),
);

live("a mounted pane follows a replacement view and ignores its retired cleanup", () =>
  Effect.gen(function* () {
    const { contributions, owner } = testContributor("harness");
    const views = createSessionViews(contributions);
    const scene = yield* workspace(views.view);

    const first = views.register(owner, "native", () => <text>first harness</text>);
    yield* draw(scene);
    expect(scene.t.captureCharFrame()).toContain("first harness");

    const next = { id: owner.id, generation: owner.generation + 1 };
    const second = views.register(next, "native", () => <text>second harness</text>);
    yield* draw(scene);
    expect(scene.t.captureCharFrame()).toContain("first harness");

    contributions.commit(next);
    yield* draw(scene);
    expect(scene.t.captureCharFrame()).toContain("second harness");

    first();
    yield* draw(scene);
    expect(scene.t.captureCharFrame()).toContain("second harness");

    second();
    yield* draw(scene);
    expect(scene.t.captureCharFrame()).toContain("Pane type 'native' is unavailable.");
  }),
);

live("a component leaf tiles as the exact rectangle the layout model says", () =>
  Effect.gen(function* () {
    const layout = makeLayout({
      root: {
        type: "split",
        direction: "row",
        weight: 1,
        children: [
          { type: "pane", id: "chat-pane", content: pluginContent("chat"), weight: 1 },
          { type: "pane", id: "shell-pane", content: ptyContent("shell"), weight: 1 },
        ],
      },
      focus: "shell-pane",
    });
    const scene = yield* workspace(label, layout, { shell: {} });
    yield* draw(scene);

    // The same fixed point geometry.test.ts holds terminal panes to: opentui's
    // flex result and the model's arithmetic must agree, or a component leaf is
    // in a different place than every command that addresses it believes.
    const w = scene.window;
    const expected = computeRects(layout, { cols: w.root.width, rows: w.root.height });
    expect(w.panes).toHaveLength(2);
    for (const pane of w.panes) {
      expect(expected.get(pane.id)).toEqual({
        x: pane.x - w.root.x,
        y: pane.y - w.root.y,
        width: pane.width,
        height: pane.height,
      });
    }
  }),
);

live("a component leaf splits, focuses and closes like any other pane", () =>
  Effect.gen(function* () {
    const scene = yield* workspace(label, makeLayout({
      root: {
        type: "split",
        direction: "row",
        weight: 1,
        children: [
          { type: "pane", id: "chat-pane", content: pluginContent("chat"), weight: 1 },
          { type: "pane", id: "shell-pane", content: ptyContent("shell"), weight: 1 },
        ],
      },
      focus: "shell-pane",
    }), { shell: {} });
    yield* draw(scene);

    const chatPane = scene.window.panes.find((p) => p.id === "chat-pane")!;
    const shellPane = scene.window.panes.find((p) => p.id === "shell-pane")!;

    expect(scene.window.panes).toHaveLength(2);
    expect(scene.window.focused).toBe(shellPane);

    scene.window.focus(chatPane);
    expect(scene.window.focused).toBe(chatPane);
    expect(chatPane.active).toBe(true);
    expect(shellPane.active).toBe(false);

    scene.window.close(chatPane);
    expect(chatPane.isDestroyed).toBe(true);
    expect(scene.window.panes).toEqual([shellPane]);
  }),
);

live("a component leaf survives a rebuild rather than being remounted", () =>
  Effect.gen(function* () {
    const scene = yield* workspace(label, makeLayout({
      root: {
        type: "split",
        direction: "row",
        weight: 1,
        children: [
          { type: "pane", id: "chat-pane", content: pluginContent("chat"), weight: 1 },
          { type: "pane", id: "shell-pane", content: ptyContent("shell"), weight: 1 },
        ],
      },
      focus: "chat-pane",
    }), { shell: {} });
    yield* draw(scene);

    const chatPane = scene.window.panes.find((p) => p.id === "chat-pane")!;

    // Every reshape takes the tree apart and puts it back. A leaf whose content
    // is a live reactive subtree must be REUSED across that, not rebuilt: a
    // remount would silently drop whatever state the view was holding.
    yield* projectWorkspace(
      scene.spaces,
      snapshotOf(
        makeLayout({
          root: {
            type: "split",
            direction: "column",
            weight: 1,
            children: [
              { type: "pane", id: "chat-pane", content: pluginContent("chat"), weight: 1 },
              { type: "pane", id: "shell-pane", content: ptyContent("shell"), weight: 1 },
            ],
          },
          focus: "shell-pane",
        }),
        componentSessions(true),
        WIDTH,
        HEIGHT,
      ),
      scene.backend,
    );
    yield* draw(scene);

    expect(scene.window.panes).toContain(chatPane);
    expect(chatPane.isDestroyed).toBe(false);
    expect(scene.t.captureCharFrame()).toContain("view:chat");
  }),
);

live("closing a component leaf disposes its subtree", () =>
  Effect.gen(function* () {
    const scene = yield* workspace();
    yield* draw(scene);
    expect(scene.t.captureCharFrame()).toContain("view:chat");

    const pane = scene.window.panes[0]!;
    pane.destroyRecursively();
    yield* draw(scene);

    expect(scene.t.captureCharFrame()).not.toContain("view:chat");
  }),
);

/** Enough of a keystroke for the encoder: the raw bytes the outer terminal
 *  produced, which is all a pass-through needs. */
const keystroke = (raw: string) => ({ raw, sequence: raw, eventType: "press" }) as KeyEvent;

/** The pane less only the sides it actually draws. A pane facing a split does
 *  not own that border — the divider between them does. */
const inner = (pane: Pane) => pane.width - (pane.edges.left ? 1 : 0) - (pane.edges.right ? 1 : 0);

live("an unbound key is bytes to a terminal leaf and untouched by a component one", () =>
  Effect.gen(function* () {
    const scene = yield* workspace(label, makeLayout({
      root: {
        type: "split",
        direction: "row",
        weight: 1,
        children: [
          { type: "pane", id: "chat-pane", content: pluginContent("chat"), weight: 1 },
          { type: "pane", id: "shell-pane", content: ptyContent("shell"), weight: 1 },
        ],
      },
      focus: "shell-pane",
    }), { shell: {} });

    const chatPane = scene.window.panes.find((p) => p.id === "chat-pane")!;
    const shellPane = scene.window.panes.find((p) => p.id === "shell-pane")!;

    const written: string[] = [];
    shellPane.session!.write = (data) => {
      written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    };

    scene.window.focus(shellPane);
    expect(scene.window.key(keystroke("h"))).toBe(true);
    expect(written).toEqual(["h"]);

    // False, and nothing written: the key belongs to whichever renderable inside
    // the subtree holds focus, and consuming it here would stop it ever arriving.
    scene.window.focus(chatPane);
    expect(scene.window.key(keystroke("h"))).toBe(false);
    expect(written).toEqual(["h"]);
  }),
);

live("a registered captureKeys handler gets every key while its pane is focused", () =>
  Effect.gen(function* () {
    const received: KeyEvent[] = [];
    const editor: PaneView = (props) => {
      props.captureKeys((event) => {
        received.push(event);
        return true;
      });
      return <text>editor</text>;
    };
    const scene = yield* workspace(editor, makeLayout({
      root: {
        type: "split",
        direction: "row",
        weight: 1,
        children: [
          { type: "pane", id: "chat-pane", content: pluginContent("chat"), weight: 1 },
          { type: "pane", id: "shell-pane", content: ptyContent("shell"), weight: 1 },
        ],
      },
      focus: "shell-pane",
    }), { shell: {} });

    const chatPane = scene.window.panes.find((p) => p.id === "chat-pane")!;
    const shellPane = scene.window.panes.find((p) => p.id === "shell-pane")!;

    // Unfocused: the handler is not consulted — the focused terminal leaf takes
    // the key instead, and nothing reaches the editor.
    scene.window.focus(shellPane);
    expect(scene.window.key(keystroke("h"))).toBe(true);
    expect(received).toEqual([]);

    // Focused: every unclaimed key reaches the handler.
    scene.window.focus(chatPane);
    expect(scene.window.key(keystroke("h"))).toBe(true);
    expect(scene.window.key(keystroke(":"))).toBe(true);
    expect(scene.window.key(keystroke("j"))).toBe(true);
    expect(received.map((e) => e.sequence)).toEqual(["h", ":", "j"]);
  }),
);

live("a view without a captureKeys handler keeps OpenTUI focus routing", () =>
  Effect.gen(function* () {
    const scene = yield* workspace();
    const chatPane = scene.window.panes[0]!;

    scene.window.focus(chatPane);
    // No handler registered: an unbound key is untouched (returns false), the
    // same answer an unfocused component leaf gives.
    expect(scene.window.key(keystroke("h"))).toBe(false);
  }),
);

live("captureKeys is dropped when the handler is deregistered", () =>
  Effect.gen(function* () {
    const seen: KeyEvent[] = [];
    let register: (handler: ((event: KeyEvent) => boolean) | null) => void = () => {};
    const editor: PaneView = (props) => {
      register = props.captureKeys;
      return <text>editor</text>;
    };
    const scene = yield* workspace(editor);
    const chatPane = scene.window.panes[0]!;
    scene.window.focus(chatPane);

    register((event) => {
      seen.push(event);
      return true;
    });
    expect(scene.window.key(keystroke("h"))).toBe(true);
    expect(seen).toHaveLength(1);

    register(null);
    expect(scene.window.key(keystroke("h"))).toBe(false);
    expect(seen).toHaveLength(1);
  }),
);

live("a component's view sees the frame move under it", () =>
  Effect.gen(function* () {
    let mounts = 0;
    const probe: PaneView = (props) => {
      mounts++;
      return <text>{`w=${props.width()} active=${props.active()}`}</text>;
    };
    const scene = yield* workspace(probe);
    const chatPane = scene.window.panes.find((p) => p.id === "chat-pane")!;
    yield* draw(scene);

    const full = inner(chatPane);
    expect(scene.t.captureCharFrame()).toContain(`w=${full} active=true`);

    // A split narrows the pane; the composer inside it has to be told, or it
    // wraps its text to a width the pane no longer has. The split arrives as a
    // model revision — the daemon owns the arrangement, and the client replays
    // the new layout through the same reconciler production runs at boot.
    const twoPanes = (focus: string) =>
      makeLayout({
        root: {
          type: "split",
          direction: "row",
          weight: 1,
          children: [
            { type: "pane", id: "chat-pane", content: pluginContent("chat"), weight: 1 },
            { type: "pane", id: "shell-pane", content: ptyContent("shell"), weight: 1 },
          ],
        },
        focus,
      });
    yield* projectWorkspace(
      scene.spaces,
      snapshotOf(twoPanes("shell-pane"), componentSessions(true), WIDTH, HEIGHT),
      scene.backend,
    );
    const shellPane = scene.window.panes.find((p) => p.id === "shell-pane")!;
    yield* draw(scene);
    expect(inner(chatPane)).toBeLessThan(full);
    expect(scene.t.captureCharFrame()).toContain(`w=${inner(chatPane)} active=false`);

    // Focus moves the same way: the next revision names the chat pane again.
    yield* projectWorkspace(
      scene.spaces,
      snapshotOf(twoPanes("chat-pane"), componentSessions(true), WIDTH, HEIGHT),
      scene.backend,
    );
    yield* draw(scene);
    expect(scene.t.captureCharFrame()).toContain("active=true");
    expect(shellPane.active).toBe(false);

    // The view function ran once: a resize and a focus change are signal updates,
    // not a remount, which is what lets a composer keep a half-typed message.
    expect(mounts).toBe(1);
  }),
);

live("killing the session behind a component leaf closes its pane", () =>
  Effect.gen(function* () {
    const scene = yield* workspace();
    const pane = scene.window.panes[0]!;

    // The client never kills: the daemon drops the session from the model, and
    // the projection removes the pane that viewed it.
    yield* scene.window.removeProjectedSession(pane.session!);

    expect(scene.window.panes).toHaveLength(0);
    expect(pane.isDestroyed).toBe(true);
  }),
);
