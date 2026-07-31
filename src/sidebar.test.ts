import { test, expect } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Workspace } from "./workspace.ts"
import { Sidebar } from "./sidebar.ts"

const SHELL = ["bash"]

interface Harness {
  t: TestRendererSetup
  ws: Workspace
  sidebar: Sidebar
  dispose: () => Promise<void>
}

/** Real PTY + ghostty VT and the same layout as main.ts: a row holding the
 *  fixed-width sidebar beside the workspace. */
async function setup(): Promise<Harness> {
  const t = await createTestRenderer({ width: 100, height: 30 })
  const root = new BoxRenderable(t.renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  })
  t.renderer.root.add(root)

  const body = new BoxRenderable(t.renderer, { id: "body", flexDirection: "row", flexGrow: 1 })
  root.add(body)

  const ws = new Workspace(t.renderer, SHELL)
  const sidebar = new Sidebar(t.renderer, ws)
  body.add(sidebar)
  body.add(ws.root)

  ws.onChange = () => sidebar.invalidate()
  ws.init("shell")

  return {
    t,
    ws,
    sidebar,
    async dispose() {
      for (const a of [...ws.agents]) ws.killAgent(a)
      await Bun.sleep(50) // let PTY pumps observe the kill and settle
      t.renderer.destroy()
    },
  }
}

/** Wait until the sidebar region of the frame contains `needle`. */
async function waitForSidebar(h: Harness, needle: string) {
  await h.t.waitForFrame((frame) => stripSidebar(frame).includes(needle))
}

/** Wait until the sidebar region of the frame no longer contains `needle`. */
async function waitForSidebarGone(h: Harness, needle: string) {
  await h.t.waitForFrame((frame) => !stripSidebar(frame).includes(needle))
}

function stripSidebar(frame: string): string {
  return frame
    .split("\n")
    .slice(0, 6)
    .map((line) => line.slice(0, 30))
    .join("\n")
}

test("sidebar renders beside the workspace and lists the seeded agent", async () => {
  const s = await setup()
  try {
    await waitForSidebar(s, "1 agent")
    const top = s.t.captureCharFrame().split("\n")[0] ?? ""
    expect(top.slice(0, 30)).toContain("1 agent")
    const strip = s.t
      .captureCharFrame()
      .split("\n")
      .slice(1, 3)
      .map((line) => line.slice(0, 30))
      .join("\n")
    expect(strip).toMatch(/[○●✓]/) // status dot on the agent row
  } finally {
    await s.dispose()
  }
})

test("toggle shows and hides the sidebar", async () => {
  const s = await setup()
  try {
    expect(s.sidebar.open).toBe(true)
    s.sidebar.toggle()
    expect(s.sidebar.open).toBe(false)
    s.sidebar.toggle()
    expect(s.sidebar.open).toBe(true)
  } finally {
    await s.dispose()
  }
})

test("detached agents get the detached indicator and are revealed by selection", async () => {
  const s = await setup()
  try {
    const bg = s.ws.spawn("background", ["sleep", "30"])
    expect(bg.viewers).toBe(0)
    await waitForSidebar(s, "⇠")

    // Enter on the detached agent reveals it: a pane opens and it stops being detached.
    s.sidebar.selectFocused()
    s.sidebar.move(1)
    expect(s.sidebar.selected).toBe(bg)
    expect(s.sidebar.reveal()).toBe(true)
    expect(bg.viewers).toBe(1)
    expect(s.ws.detached).not.toContain(bg)
  } finally {
    await s.dispose()
  }
})

test("output on a detached agent marks it unseen", async () => {
  const s = await setup()
  try {
    s.ws.spawn("chatter", ["sh", "-c", "echo hello-from-detached; sleep 5"])
    await waitForSidebar(s, "⇠")
    await waitForSidebar(s, "*")
  } finally {
    await s.dispose()
  }
})

test("keyboard selects, reveals, and kills agents", async () => {
  const s = await setup()
  try {
    const killme = s.ws.spawn("killme", ["sleep", "30"])
    const keep = s.ws.spawn("keep", ["sleep", "30"])

    expect(s.sidebar.handleKey("\x1b[B")).toBe(true) // down: select agent 1
    expect(s.sidebar.selected).toBe(killme)
    expect(s.sidebar.handleKey("\x1b[B")).toBe(true) // down: select agent 2
    expect(s.sidebar.selected).toBe(keep)
    expect(s.sidebar.handleKey("k")).toBe(true) // up
    expect(s.sidebar.selected).toBe(killme)
    expect(s.sidebar.handleKey("x")).toBe(true) // kill selected
    expect(s.ws.agents).not.toContain(killme)
    expect(s.ws.agents).toContain(keep)
  } finally {
    await s.dispose()
  }
})

test("scrolled state shows the ▲ indicator and clears on scrollToBottom", async () => {
  const s = await setup()
  try {
    const bg = s.ws.spawn("scrolly", ["sleep", "30"])
    await waitForSidebar(s, "⇠")
    expect(bg.scrolled).toBe(false)
    bg.scrollBy(3)
    await waitForSidebar(s, "▲")
    expect(bg.scrolled).toBe(true)
    bg.scrollToBottom()
    await waitForSidebarGone(s, "▲")
    expect(bg.scrolled).toBe(false)
  } finally {
    await s.dispose()
  }
})

test("mouse click on a row reveals the agent", async () => {
  const s = await setup()
  try {
    const bg = s.ws.spawn("clickme", ["sleep", "30"])
    await waitForSidebar(s, "⇠")

    // Header is row 0; clicking row 1 selects+reveals the second agent.
    await s.t.mockMouse.click(15, 2)
    expect(bg.viewers).toBe(1)
    expect(s.ws.detached).not.toContain(bg)
  } finally {
    await s.dispose()
  }
})
