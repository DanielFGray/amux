/** @jsxImportSource @opentui/solid */
import { scopedSpaceSet } from "../harness.ts";
import { Effect } from "effect";
import { test, expect, afterEach } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { SpaceSet, type Space } from "../space.ts";
import { frame } from "../window.ts";
import { resolveOptions } from "../options.ts";
import { createAppState } from "./state.ts";
import { App } from "./App.tsx";
import type { Panel } from "./regions.tsx";
import { testRegions } from "./test-regions.ts";
import { WindowTabs } from "./WindowTabs.tsx";
import { Settings } from "./Settings.tsx";
import { Hints } from "./Hints.tsx";
import type { HintGroup } from "../bindings.ts";
import { workspaceEnv } from "../env.ts";

const WIDTH = 60;
const HEIGHT = 14;
const SIDEBAR = 16;

/** The options these tests vary: the sidebar's presence and the pane frame's
 *  column. The resize handle is independent of that frame. */
const sidebar = (open: boolean) =>
  resolveOptions({ "sidebar.open": open, "sidebar.width": SIDEBAR });

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  frame.externalLeft = false;
});

/** Mount the real App around a real split tree and return the drawn frame. */
async function screen(
  open: boolean,
  build: (win: Space) => void,
  extra: Partial<{
    hints: HintGroup[];
    hintsVisible: boolean;
    overlay: boolean;
    reopen: boolean;
  }> = {},
) {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
  const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer), paneHost);
  const app = createAppState(spaces);
  cleanup.push(() => {
    t.renderer.destroy();
  });

  frame.externalLeft = false;
  const [options, setOptions] = createSignal(sidebar(open));
  const space = Effect.runSync(spaces.create("proj", process.cwd()));
  build(space);
  spaces.refreshChrome();

  // The same panels the app registers, minus the ones no check here draws.
  const { regions, owner } = testRegions(t.renderer);
  const register = (panel: Panel) => regions.register(owner, panel);
  cleanup.push(
    register({
      id: "test.sidebar",
      region: "left",
      anchor: "app",
      visible: () => options()["sidebar.open"],
      size: () => options()["sidebar.width"],
      resizable: true,
      onResize: () => {},
      component: () => (
        <box style={{ width: options()["sidebar.width"], height: "100%" }}>
          <text>proj</text>
        </box>
      ),
    }),
  );
  cleanup.push(
    register({
      id: "test.windows",
      region: "top",
      anchor: "center",
      size: () => 1,
      component: () => (
        <WindowTabs
          app={app}
          windows={app.active()?.windows ?? []}
          active={app.activeWindow()}
          pending={["^a"]}
          copying={false}
          onSelect={() => {}}
        />
      ),
    }),
  );
  cleanup.push(
    register({
      id: "test.settings",
      region: "overlay",
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
        />
      ),
    }),
  );
  cleanup.push(
    register({
      id: "test.hints",
      region: "float",
      visible: () =>
        (extra.hintsVisible ?? true) &&
        (extra.hints ?? []).length > 0 &&
        regions.topOverlay() === null,
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
    () => <App regions={regions} paneHost={paneHost} size={{ width: WIDTH, height: HEIGHT }} />,
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
  const rows = await screen(true, (space) => {
    Effect.runSync(Effect.flatMap(space.newWindow(), (w) => w.init()));
  });

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

test("a horizontal split tees into the sidebar seam instead of stopping short", async () => {
  const rows = await screen(true, (space) => {
    const win = Effect.runSync(space.newWindow());
    Effect.runSync(win.init());
    Effect.runSync(win.splitSpawn("column"));
  });

  const seam = rows.map((row) => row[SIDEBAR]);
  expect(seam).toContain("├");
  // Still exactly one corner at each end, and no stray tee anywhere else.
  expect(seam.filter((c) => c === "┌")).toHaveLength(1);
  expect(seam.filter((c) => c === "└")).toHaveLength(1);
});

test("closing the sidebar hands the left border back to the panes", async () => {
  const rows = await screen(false, (space) => {
    Effect.runSync(Effect.flatMap(space.newWindow(), (w) => w.init()));
  });

  expect(rows[1]![0]).toBe("┌");
  expect(rows[HEIGHT - 1]![0]).toBe("└");
});

test("re-enabling the sidebar keeps the pane frame behind its handle", async () => {
  const rows = await screen(
    true,
    (space) => Effect.runSync(Effect.flatMap(space.newWindow(), (w) => w.init())),
    { reopen: true },
  );

  expect(rows[1]![SIDEBAR]).toBe("┌");
  expect(rows[Math.floor(HEIGHT / 2)]![SIDEBAR]).toBe("│");
  expect(rows[HEIGHT - 1]![SIDEBAR]).toBe("└");
});

/** Split both halves of a row split vertically at the same height, so the two
 *  horizontal seams land on the same row and both meet the vertical seam. */
function cross(space: Space) {
  const win = Effect.runSync(space.newWindow());
  Effect.runSync(win.init());
  Effect.runSync(win.splitSpawn("row"));
  const left = win.panes[0]!;
  const right = win.panes[1]!;
  win.focus(left);
  Effect.runSync(win.splitSpawn("column"));
  win.focus(right);
  Effect.runSync(win.splitSpawn("column"));
}

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
  const rows = await screen(
    true,
    (space) => Effect.runSync(Effect.flatMap(space.newWindow(), (w) => w.init())),
    { hints: HINTS },
  );

  // The panel's own top border replaces the frame's, one row below the tabs.
  expect(rows[1]!.slice(0, SIDEBAR)).not.toContain("┌");
  expect(rows[1]![SIDEBAR]).toBe("┌");
  expect(rows.join("\n")).toContain("z zoom");
  // The tree is still readable underneath it.
  expect(rows.join("\n")).toContain("proj");
});

test("the hint panel stays out of the way of an open overlay", async () => {
  const rows = await screen(
    true,
    (space) => Effect.runSync(Effect.flatMap(space.newWindow(), (w) => w.init())),
    {
      hints: HINTS,
      overlay: true,
    },
  );

  expect(rows.join("\n")).not.toContain("z zoom");
  expect(rows.join("\n")).toContain("settings");
});

test("the hint panel can be hidden while the prefix remains active", async () => {
  const rows = await screen(
    true,
    (space) => Effect.runSync(Effect.flatMap(space.newWindow(), (w) => w.init())),
    { hints: HINTS, hintsVisible: false },
  );

  expect(rows.join("\n")).not.toContain("z zoom");
});
