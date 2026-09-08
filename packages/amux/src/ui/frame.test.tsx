/** @effect-diagnostics *:skip-file -- plain-async by design: this suite drives the SolidJS/opentui render tree; see the seam documented in packages/amux/src/harness.ts. */
/** @jsxImportSource @opentui/solid */
import { Effect, Exit, Scope } from "effect";
import { Context } from "effect";
import { test, expect, afterEach } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { SpaceSet, projectWorkspace } from "../space.ts";
import { workspaceEnv, Backend } from "../env.ts";
import { snapshotOf } from "../harness.ts";
import { makeLayout, type Layout } from "../layout.ts";
import { resolveOptions, type Options, type OptionValue } from "../options.ts";
import { formatText } from "../format.ts";
import { createAppState } from "./state.ts";
import { App } from "./App.tsx";
import { testSlots } from "./test-slots.ts";
import { WindowTabs } from "./WindowTabs.tsx";
import { createProcessDisplay } from "../plugin/process-display.ts";
import { createPluginContributions } from "../plugin/contributions.ts";
import { Settings } from "./Settings.tsx";
import { Hints } from "./Hints.tsx";
import type { HintGroup } from "../bindings.ts";

const WIDTH = 60;
const HEIGHT = 14;
const SIDEBAR = 16;

/** The options these tests vary: the sidebar's presence and the pane frame's
 *  column. The resize handle is independent of that frame. `sidebar.*` is the
 *  sidebar plugin's own option, not core, so it is added onto the resolved
 *  core defaults rather than through `resolveOptions`. */
const sidebar = (open: boolean) =>
  ({
    ...resolveOptions({}),
    "sidebar.open": open,
    "sidebar.width": SIDEBAR,
  }) as Options & Record<string, OptionValue>;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const pty = (id: string, session: string) =>
  ({ type: "pane" as const, id, content: { kind: "pty" as const, session }, weight: 1 });

/** A shell session whose tab shows "bash", the same as `init()` seeded. */
const bash = { cmd: ["bash"] };

/** One session filling one window. */
const single = (): Layout => makeLayout({ root: pty("p1", "s1"), focus: "p1" });

/** A horizontal split. */
const verticalSplit = (): Layout =>
  makeLayout({
    root: {
      type: "split",
      direction: "column",
      weight: 1,
      children: [pty("p1", "s1"), pty("p2", "s2")],
    },
    focus: "p2",
  });

/** Both halves of a row split broken vertically, at the same height — the 2x2
 *  grid `cross()` used to build, so the two horizontal seams land on one row
 *  and both meet the vertical seam. */
const cross = (): Layout =>
  makeLayout({
    root: {
      type: "split",
      direction: "row",
      weight: 1,
      children: [
        { type: "split", direction: "column", weight: 1, children: [pty("p1", "s1"), pty("p2", "s2")] },
        { type: "split", direction: "column", weight: 1, children: [pty("p3", "s3"), pty("p4", "s4")] },
      ],
    },
    focus: "p4",
  });

const sessionsFor = (layout: Layout) => {
  const ids = new Set<string>();
  const walk = (node: NonNullable<Layout["root"]>): void => {
    if (node.type === "pane") {
      if (node.content.kind === "pty") ids.add(node.content.session);
    } else for (const child of node.children) walk(child);
  };
  if (layout.root) walk(layout.root);
  return Object.fromEntries([...ids].map((id) => [id, bash]));
};

/** Mount the real App around a real split tree and return the drawn frame. */
async function screen(
  open: boolean,
  layoutFn: () => Layout,
  extra: Partial<{
    hints: HintGroup[];
    hintsVisible: boolean;
    overlay: boolean;
    reopen: boolean;
    format: string;
    status: string;
    spaceIndex: number;
  }> = {},
) {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
  t.renderer.root.add(paneHost);
  const env = workspaceEnv(t.renderer);
  const scope = Scope.makeUnsafe();
  const spaces = Effect.runSync(Scope.provide(SpaceSet.make(env, paneHost), scope));
  Effect.runSync(
    Scope.provide(
      projectWorkspace(
        spaces,
        snapshotOf(layoutFn(), sessionsFor(layoutFn())),
        Context.get(env, Backend),
      ),
      scope,
    ),
  );
  const app = createAppState(spaces);
  cleanup.push(() => {
    void Effect.runPromise(Scope.close(scope, Exit.void));
    t.renderer.destroy();
  });

  const [options, setOptions] = createSignal(sidebar(open));

  // The same panels the app registers, minus the ones no check here draws.
  const { slots, owner } = testSlots(t.renderer);
  cleanup.push(
    slots.register(owner, "left.app", {
      id: "test.sidebar",
      visible: () => options()["sidebar.open"] as boolean,
      size: () => options()["sidebar.width"] as number,
      resizable: true,
      onResize: () => {},
      component: () => (
        <box style={{ width: options()["sidebar.width"] as number, height: "100%" }}>
          <text>proj</text>
        </box>
      ),
    }),
  );
  cleanup.push(
    slots.register(owner, "top.center", {
      id: "test.windows",
      size: () => 1,
      component: () => (
        <WindowTabs
          app={app}
          processDisplay={createProcessDisplay(createPluginContributions())}
          windows={app.active()?.windows ?? []}
          active={app.activeWindow()}
          format={extra.format}
          status={extra.status}
          spaceIndex={extra.spaceIndex}
          pending={["^a"]}
          copying={false}
          onSelect={() => {}}
        />
      ),
    }),
  );
  cleanup.push(
    slots.register(owner, "overlay", {
      id: "test.settings",
      visible: () => extra.overlay ?? false,
      component: (props) => (
        <Settings
          options={options()}
          section="sidebar"
          selected={0}
          groups={[]}
          leader="ctrl+a"
          conflicts={[]}
          capturing={false}
          width={props.width}
          height={props.height}
          dirty={false}
          focus="items"
          onEditInput={() => {}}
          onEditSubmit={() => {}}
        />
      ),
    }),
  );
  cleanup.push(
    slots.register(owner, "float", {
      id: "test.hints",
      visible: () =>
        (extra.hintsVisible ?? true) &&
        (extra.hints ?? []).length > 0 &&
        slots.topOverlay() === null,
      component: (props) => (
        <Hints
          groups={extra.hints ?? []}
          pending="^a"
          left={props.left}
          width={props.width}
          height={props.height}
        />
      ),
    }),
  );

  await render(
    () => <App slots={slots} paneHost={paneHost} size={{ width: WIDTH, height: HEIGHT }} />,
    t.renderer,
  );
  await t.renderOnce();
  await t.renderOnce();
  if (extra.reopen) {
    setOptions(sidebar(false));
    spaces.refreshChrome();
    await t.renderOnce();
    setOptions(sidebar(true));
    spaces.refreshChrome();
    await t.renderOnce();
    await t.renderOnce();
  }
  return t.captureCharFrame().split("\n");
}

test("the sidebar seam is a single line that is also the pane frame's left border", async () => {
  const rows = await screen(true, single);

  // Row 0 is the window tab bar; the frame starts under it.
  const top = rows[1]!;
  const middle = rows[Math.floor(HEIGHT / 2)]!;
  const bottom = rows[HEIGHT - 1]!;

  // One corner, then the top border — not a divider followed by a second line.
  expect(top[SIDEBAR]).toBe("┌");
  expect(top[SIDEBAR + 1]).toBe("─");
  expect(middle[SIDEBAR]).toBe("│");
  expect(middle[SIDEBAR + 1]).not.toBe("│");
  expect(bottom[SIDEBAR]).toBe("└");
});

test("window tabs render the configured format", async () => {
  const rows = await screen(false, single, { format: "tab-#{window_number}-#{window_name}", spaceIndex: 0 });

  expect(rows[0]).toContain("tab-1-bash");
  expect(rows[0]).not.toContain("○");
});

test("window tabs render the state glyph and space index when requested", async () => {
  const rows = await screen(false, single, { format: "#{agent_state_glyph} space-#{space_index}", spaceIndex: 0 });

  expect(rows[0]).toContain("· space-0");
});

test("window tabs render the configured status format", async () => {
  const statusFormat = resolveOptions({ "status.format": "status-#{space_name}" })["status.format"];
  const rows = await screen(false, single, { status: formatText(statusFormat, { space_name: "proj" }) });

  expect(rows[0]).toContain("status-proj");
});

test("a horizontal split tees into the sidebar seam instead of stopping short", async () => {
  const rows = await screen(true, verticalSplit);

  const seam = rows.map((row) => row[SIDEBAR]);
  expect(seam).toContain("├");
  // Still exactly one corner at each end, and no stray tee anywhere else.
  expect(seam.filter((c) => c === "┌")).toHaveLength(1);
  expect(seam.filter((c) => c === "└")).toHaveLength(1);
});

test("closing the sidebar hands the left border back to the panes", async () => {
  const rows = await screen(false, single);

  expect(rows[1]![0]).toBe("┌");
  expect(rows[HEIGHT - 1]![0]).toBe("└");
});

test("re-enabling the sidebar keeps the pane frame behind its handle", async () => {
  const rows = await screen(true, single, { reopen: true });

  expect(rows[1]![SIDEBAR]).toBe("┌");
  expect(rows[Math.floor(HEIGHT / 2)]![SIDEBAR]).toBe("│");
  expect(rows[HEIGHT - 1]![SIDEBAR]).toBe("└");
});

test("a seam crossing the pane frame's seam draws a ┼, not the last tee", async () => {
  const rows = await screen(false, cross);

  // The vertical seam meets the top border at its ┬; below it, on the row
  // where both horizontal seams converge, the same cell is a ┼ — the glyph the
  // geometry demands, whichever divider drew it last.
  const col = rows[1]!.indexOf("┬");
  expect(col).toBeGreaterThan(0);
  expect(rows[7]![col]).toBe("┼");
  // The frame still caps the vertical seam at top and bottom.
  expect(rows[HEIGHT - 1]![col]).toBe("┴");
});

test("the ┼ also lands on the sidebar seam when the sidebar is open", async () => {
  const rows = await screen(true, cross);

  const col = rows[1]!.indexOf("┬");
  expect(col).toBeGreaterThan(SIDEBAR);
  // The crossing cell is a ┼, and the two horizontal seams tee into the
  // sidebar handle exactly once, keeping the single-line seam intact.
  expect(rows[7]![col]).toBe("┼");
  const seam = rows.map((row) => row[SIDEBAR]);
  expect(seam.filter((c) => c === "├")).toHaveLength(1);
  expect(seam.filter((c) => c === "┌")).toHaveLength(1);
  expect(seam.filter((c) => c === "└")).toHaveLength(1);
});

const HINTS: HintGroup[] = [{ group: "panes", entries: [{ keys: ["z"], desc: "zoom" }] }];

test("the hint panel starts at the pane area, not over the sidebar tree", async () => {
  const rows = await screen(true, single, { hints: HINTS });

  // The panel's own top border replaces the frame's, one row below the tabs.
  expect(rows[1]!.slice(0, SIDEBAR)).not.toContain("┌");
  expect(rows[1]![SIDEBAR]).toBe("┌");
  expect(rows.join("\n")).toContain("z zoom");
  // The tree is still readable underneath it.
  expect(rows.join("\n")).toContain("proj");
});

test("the hint panel stays out of the way of an open overlay", async () => {
  const rows = await screen(true, single, { hints: HINTS, overlay: true });

  expect(rows.join("\n")).not.toContain("z zoom");
  expect(rows.join("\n")).toContain("settings");
});

test("the hint panel can be hidden while the prefix remains active", async () => {
  const rows = await screen(true, single, { hints: HINTS, hintsVisible: false });

  expect(rows.join("\n")).not.toContain("z zoom");
});
