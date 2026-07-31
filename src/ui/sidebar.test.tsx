/** @jsxImportSource @opentui/solid */
import { test, expect } from "bun:test"
import { createSignal } from "solid-js"
import { BoxRenderable } from "@opentui/core"
import { render } from "@opentui/solid"
import { createTestRenderer } from "@opentui/core/testing"
import { SpaceSet } from "../space.ts"
import { createAppState } from "./state.ts"
import { Sidebar, sidebarTargets } from "./Sidebar.tsx"

const SHELL = ["bash"]

async function setup() {
  const [selected, setSelected] = createSignal(0)
  const [hovered, setHovered] = createSignal<number | null>(null)
  const activated: number[] = []

  // Renderer and domain first, then mount Solid into that same renderer —
  // Solid's render() accepts an existing CliRenderer, which is also how the
  // real app hosts the imperative pane tree alongside the reactive chrome.
  const t = await createTestRenderer({ width: 60, height: 20 })
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 })
  const spaces = new SpaceSet(t.renderer, paneHost, SHELL)
  const space = spaces.create("proj", process.cwd())
  space.workspace.init("shell")
  const app = createAppState(spaces)

  await render(
    () => (
      <Sidebar
        app={app}
        width={30}
        selected={selected()}
        hovered={hovered()}
        focused={false}
        onHover={setHovered}
        onActivate={(i) => activated.push(i)}
      />
    ),
    t.renderer,
  )

  return {
    t,
    spaces,
    space,
    hovered,
    setSelected,
    activated,
    async dispose() {
      spaces.disposeAll()
      app.dispose()
      await Bun.sleep(50)
      t.renderer.destroy()
    },
  }
}

test("renders the space/agent tree with a state glyph per row", async () => {
  const s = await setup()
  try {
    await s.t.waitForFrame((f: string) => f.includes("1 space"))
    const frame = s.t.captureCharFrame()
    expect(frame).toContain("1 space · 1 agent")
    expect(frame).toContain("proj")
    expect(frame).toMatch(/[○●✓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  } finally {
    await s.dispose()
  }
})

test("the branch row appears under its space once git info arrives", async () => {
  const s = await setup()
  try {
    await s.t.waitForFrame((f: string) => f.includes("proj"))
    // No branch row until the app supplies git info — it is not guessed.
    expect(s.t.captureCharFrame()).not.toContain("feat/thing")

    s.space.branch = "feat/thing"
    s.space.ahead = 2
    s.space.behind = 1
    // A plain field write is enough: onChange -> refresh drives the repaint.
    s.spaces.onChange?.()

    await s.t.waitForFrame((f: string) => f.includes("feat/thing"))
    const frame = s.t.captureCharFrame()
    expect(frame).toContain("↑2")
    expect(frame).toContain("↓1")
  } finally {
    await s.dispose()
  }
})

test("a detached agent shows the detached indicator", async () => {
  const s = await setup()
  try {
    s.space.workspace.spawn("background", ["sleep", "30"])
    s.spaces.onChange?.()
    await s.t.waitForFrame((f: string) => f.includes("⇠"))
    expect(s.t.captureCharFrame()).toContain("background")
  } finally {
    await s.dispose()
  }
})

test("hover follows the pointer between rows, not just on entry", async () => {
  const s = await setup()
  try {
    s.space.workspace.spawn("alpha", ["sleep", "30"])
    s.space.workspace.spawn("beta", ["sleep", "30"])
    s.spaces.onChange?.()
    await s.t.waitForFrame((f: string) => f.includes("beta"))

    // OpenTUI emits "over" once on entry and "move" for every position after
    // that inside the same renderable; handling both is what makes the
    // highlight track the pointer instead of sticking to the entry row.
    await s.t.mockMouse.moveTo(10, 1)
    expect(s.hovered()).toBe(0)
    await s.t.mockMouse.moveTo(10, 3)
    expect(s.hovered()).toBe(2)
    await s.t.mockMouse.moveTo(10, 2)
    expect(s.hovered()).toBe(1)
  } finally {
    await s.dispose()
  }
})

test("clicking a row reports its selectable index, skipping the branch line", async () => {
  const s = await setup()
  try {
    s.space.branch = "main"
    s.space.workspace.spawn("clickme", ["sleep", "30"])
    s.spaces.onChange?.()
    await s.t.waitForFrame((f: string) => f.includes("clickme"))

    // Rows: 0 header, 1 space(index 0), 2 branch(not selectable), 3 shell(1),
    // 4 clickme(2). The branch line has no handler, so clicking it is inert.
    await s.t.mockMouse.click(10, 2)
    expect(s.activated).toEqual([])

    await s.t.mockMouse.click(10, 4)
    expect(s.activated).toEqual([2])
  } finally {
    await s.dispose()
  }
})
