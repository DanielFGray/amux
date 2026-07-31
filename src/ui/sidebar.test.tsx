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
  const win = space.newWindow()
  win.init("shell")
  const app = createAppState(spaces)

  await render(
    () => (
      <Sidebar
        app={app}
        width={30}
        selected={selected()}
        hovered={hovered()}
        focused={false}
        toggleKeys="^a b"
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
    win,
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
    s.win.spawn("background", ["sleep", "30"])
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
    s.win.spawn("alpha", ["sleep", "30"])
    s.win.spawn("beta", ["sleep", "30"])
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
    s.win.spawn("clickme", ["sleep", "30"])
    s.spaces.onChange?.()
    await s.t.waitForFrame((f: string) => f.includes("clickme"))

    // Rows: 0 header, 1 space(index 0), 2 branch(not selectable), 3 window(1),
    // 4 shell(2), 5 clickme(3). The branch line has no handler, so clicking it
    // is inert.
    await s.t.mockMouse.click(10, 2)
    expect(s.activated).toEqual([])

    await s.t.mockMouse.click(10, 3)
    expect(s.activated).toEqual([1]) // the window row

    await s.t.mockMouse.click(10, 5)
    expect(s.activated).toEqual([1, 3]) // clickme, under that window
  } finally {
    await s.dispose()
  }
})

test("windows nest between the space and its agents", async () => {
  const s = await setup()
  try {
    s.win.spawn("alpha", ["sleep", "30"])
    const second = s.space.newWindow("build")
    second.init("shell")
    s.spaces.onChange?.()

    await s.t.waitForFrame((f: string) => f.includes("2:build"))
    const frame = s.t.captureCharFrame()
    // Numbered like tmux, because ^a 1..9 selects by that number.
    expect(frame).toContain("1:")
    expect(frame).toContain("2:build")

    // An agent is indented under the window that owns it.
    const lines = frame.split("\n")
    const windowRow = lines.findIndex((l) => l.includes("2:build"))
    const agentRow = lines.findIndex((l, i) => i > windowRow && l.includes("shell"))
    expect(agentRow).toBeGreaterThan(windowRow)
    const indentOf = (l: string) => l.length - l.replace(/^\s+/, "").length
    expect(indentOf(lines[agentRow]!)).toBeGreaterThan(indentOf(lines[windowRow]!))
  } finally {
    await s.dispose()
  }
})

test("breaking a pane re-renders it under its new window", async () => {
  const s = await setup()
  try {
    s.win.split("row") // the newcomer (bash) takes focus, so the tab reads 1:bash
    await s.t.waitForFrame((f: string) => f.includes("1:bash"))

    // No manual refresh: breakPane must drive the repaint itself, the way any
    // structural change does — this is the "tabs update" half of the contract.
    s.space.breakPane(s.win.panes[1]!)

    // The broken-out pane now hangs under a fresh 2:, and the source window
    // collapsed back to its surviving shell.
    await s.t.waitForFrame((f: string) => f.includes("2:bash"))
    const frame = s.t.captureCharFrame()
    expect(frame).toContain("1:shell")
    expect(s.space.active?.number).toBe(2)
  } finally {
    await s.dispose()
  }
})
