/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { BoxRenderable, type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { createSignal } from "solid-js"
import { App } from "./App.tsx"
import { createRegions, type Regions } from "./regions.tsx"

const WIDTH = 24
const HEIGHT = 6
const LEFT = 6

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

/** A renderer with the region layout mounted on it, and nothing docked yet. */
async function mount() {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT })
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 })
  const regions = createRegions(t.renderer)
  cleanup.push(() => t.renderer.destroy())
  return {
    regions,
    async draw() {
      await render(
        () => <App regions={regions} paneHost={paneHost} size={{ width: WIDTH, height: HEIGHT }} />,
        t.renderer,
      )
      await t.renderOnce()
      await t.renderOnce()
      return t.captureCharFrame().split("\n")
    },
  }
}

/** A panel that paints one row of its dock, so a row says where it starts and
 *  panels stacked in the same dock stay told apart. */
const filled = (char: string) => () => (
  <text style={{ width: "100%", height: 1 }}>{char.repeat(WIDTH)}</text>
)

function leftDock(regions: Regions, size = () => LEFT) {
  regions.register({
    id: "test.left",
    region: "left",
    anchor: "app",
    size,
    component: filled("L"),
  })
}

test("a top dock anchored to the app spans the left dock as well", async () => {
  const { regions, draw } = await mount()
  leftDock(regions)
  regions.register({
    id: "test.bar",
    region: "top",
    anchor: "app",
    size: () => 1,
    component: filled("T"),
  })

  const rows = await draw()
  expect(rows[0]!.slice(0, 3)).toBe("TTT")
  // The left dock starts under it, not beside it.
  expect(rows[1]!.slice(0, LEFT)).toBe("L".repeat(LEFT))
})

test("a top dock anchored to the centre sits beside the left dock instead", async () => {
  const { regions, draw } = await mount()
  leftDock(regions)
  regions.register({
    id: "test.tabs",
    region: "top",
    anchor: "center",
    size: () => 1,
    component: filled("T"),
  })

  const rows = await draw()
  // The row the tab bar is on belongs to the left dock up to its width, and to
  // the tab bar after it. This is the whole reason a dock declares an anchor:
  // the same "top, height 1" panel lands in a different place.
  expect(rows[0]!.slice(0, LEFT)).toBe("L".repeat(LEFT))
  expect(rows[0]![LEFT]).toBe("T")
})

test("a dock is as thick as its thickest visible panel", async () => {
  const { regions, draw } = await mount()
  const [wide, setWide] = createSignal(false)
  leftDock(regions)
  regions.register({
    id: "test.left-wide",
    region: "left",
    anchor: "app",
    // Registered throughout, so the dock keeps its box while the panel is away.
    visible: wide,
    size: () => LEFT * 2,
    component: filled("W"),
  })

  const rows = await draw()
  expect(rows[0]!.slice(0, LEFT)).toBe("L".repeat(LEFT))
  expect(rows[0]![LEFT]).not.toBe("L")

  setWide(true)
  const grown = await draw()
  // Both panels are as wide as the dock now, whichever of them asked for it.
  expect(grown[0]!.slice(0, LEFT * 2)).toBe("L".repeat(LEFT * 2))
  expect(grown[1]!.slice(0, LEFT * 2)).toBe("W".repeat(LEFT * 2))
})

test("the topmost overlay owns the keys the keymap did not claim", async () => {
  const { regions } = await mount()
  const seen: string[] = []
  const [prompt, setPrompt] = createSignal(false)
  const record = (id: string) => (event: KeyEvent) => {
    seen.push(`${id}:${event.name}`)
    return true
  }

  regions.register({
    id: "test.settings",
    region: "overlay",
    order: 10,
    keys: record("settings"),
    component: filled("S"),
  })
  regions.register({
    id: "test.prompt",
    region: "overlay",
    order: 40,
    visible: prompt,
    keys: record("prompt"),
    component: filled("P"),
  })

  const key = { name: "escape" } as KeyEvent
  regions.topOverlay()?.keys?.(key)
  setPrompt(true)
  // Opened last and ordered highest, so it takes the keystroke off the settings
  // window without either of them knowing the other exists.
  regions.topOverlay()?.keys?.(key)
  expect(seen).toEqual(["settings:escape", "prompt:escape"])
})

test("an overlay that is not up is not asked about anything", async () => {
  const { regions } = await mount()
  regions.register({
    id: "test.closed",
    region: "overlay",
    visible: () => false,
    keys: () => true,
    component: filled("C"),
  })

  expect(regions.topOverlay()).toBeNull()
})

test("a panel that throws does not take the rest of the screen with it", async () => {
  const { regions, draw } = await mount()
  const errors: unknown[] = []
  const complain = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  cleanup.push(() => {
    console.error = complain
  })

  leftDock(regions)
  regions.register({
    id: "test.broken",
    region: "left",
    anchor: "app",
    size: () => LEFT,
    component: () => {
      throw new Error("panel is broken")
    },
  })

  const rows = await draw()
  expect(rows[0]!.slice(0, LEFT)).toBe("L".repeat(LEFT))
  expect(errors.length).toBeGreaterThan(0)
})
