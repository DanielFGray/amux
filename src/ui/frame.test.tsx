/** @jsxImportSource @opentui/solid */
import { test, expect, afterEach } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { Divider } from "../divider.ts"
import { SpaceSet } from "../space.ts"
import { frame } from "../window.ts"
import { loadConfig } from "../config.ts"
import { createAppState } from "./state.ts"
import { App } from "./App.tsx"
import type { HintGroup } from "../bindings.ts"

const WIDTH = 60
const HEIGHT = 14
const SIDEBAR = 16

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  frame.externalLeft = false
})

/** Mount the real App around a real split tree and return the drawn frame. */
async function screen(
  open: boolean,
  build: (win: ReturnType<SpaceSet["create"]>) => void,
  extra: Partial<{ hints: HintGroup[]; overlay: "none" | "settings" }> = {},
) {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT })
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 })
  const spaces = new SpaceSet(t.renderer, paneHost, ["bash"])
  const app = createAppState(spaces)
  cleanup.push(() => {
    spaces.disposeAll()
    app.dispose()
    t.renderer.destroy()
  })

  const handle = new Divider(t.renderer, { id: "sidebar-divider", axis: "row" })
  handle.tees = true
  handle.outer = true
  handle.capStart = true
  handle.capEnd = true

  frame.externalLeft = open
  const space = spaces.create("proj", process.cwd())
  build(space)
  spaces.refreshChrome()

  const config = await loadConfig()
  await render(
    () => (
      <App
        app={app}
        config={config}
        paneHost={paneHost}
        size={{ width: WIDTH, height: HEIGHT }}
        sidebarHandle={handle}
        sidebarWidth={SIDEBAR}
        sidebarOpen={open}
        sidebarFocused={false}
        sidebarToggleKeys="^a b"
        selected={0}
        hovered={null}
        onHover={() => {}}
        onActivate={() => {}}
        pending={["^a"]}
        hints={extra.hints ?? []}
        onSelectWindow={() => {}}
        overlay={extra.overlay ?? "none"}
        helpGroups={[]}
        leader="ctrl+a"
        conflicts={[]}
        capturing={false}
        settingsSection="sidebar"
        settingsSelected={0}
        settingsDirty={false}
        prompt={null}
      />
    ),
    t.renderer,
  )
  await t.renderOnce()
  await t.renderOnce()
  return t.captureCharFrame().split("\n")
}

test("the sidebar seam is a single line that is also the pane frame's left border", async () => {
  const rows = await screen(true, (space) => {
    space.newWindow().init()
  })

  // Row 0 is the window tab bar; the frame starts under it.
  const top = rows[1]!
  const middle = rows[Math.floor(HEIGHT / 2)]!
  const bottom = rows[HEIGHT - 1]!

  // One corner, then the top border — not a divider followed by a second line.
  expect(top[SIDEBAR]).toBe("┌")
  expect(top[SIDEBAR + 1]).toBe("─")
  expect(middle[SIDEBAR]).toBe("│")
  expect(middle[SIDEBAR + 1]).not.toBe("│")
  expect(bottom[SIDEBAR]).toBe("└")
})

test("a horizontal split tees into the sidebar seam instead of stopping short", async () => {
  const rows = await screen(true, (space) => {
    const win = space.newWindow()
    win.init()
    win.split("column")
  })

  const seam = rows.map((row) => row[SIDEBAR])
  expect(seam).toContain("├")
  // Still exactly one corner at each end, and no stray tee anywhere else.
  expect(seam.filter((c) => c === "┌")).toHaveLength(1)
  expect(seam.filter((c) => c === "└")).toHaveLength(1)
})

test("closing the sidebar hands the left border back to the panes", async () => {
  const rows = await screen(false, (space) => {
    space.newWindow().init()
  })

  expect(rows[1]![0]).toBe("┌")
  expect(rows[HEIGHT - 1]![0]).toBe("└")
})

const HINTS: HintGroup[] = [{ group: "panes", entries: [{ keys: ["z"], desc: "zoom" }] }]

test("the hint panel starts at the pane area, not over the sidebar tree", async () => {
  const rows = await screen(true, (space) => space.newWindow().init(), { hints: HINTS })

  // The panel's own top border replaces the frame's, one row below the tabs.
  expect(rows[1]!.slice(0, SIDEBAR)).not.toContain("┌")
  expect(rows[1]![SIDEBAR]).toBe("┌")
  expect(rows.join("\n")).toContain("z zoom")
  // The tree is still readable underneath it.
  expect(rows.join("\n")).toContain("proj")
})

test("the hint panel stays out of the way of an open overlay", async () => {
  const rows = await screen(true, (space) => space.newWindow().init(), {
    hints: HINTS,
    overlay: "settings",
  })

  expect(rows.join("\n")).not.toContain("z zoom")
  expect(rows.join("\n")).toContain("settings")
})
