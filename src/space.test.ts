import { test, expect } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { SpaceSet, type Space } from "./space.ts"

const SHELL = ["bash"]

interface Harness {
  t: TestRendererSetup
  spaces: SpaceSet
  space: Space
  ws: Space["workspace"]
  dispose: () => Promise<void>
}

/** Real PTYs and a real ghostty VT behind a real renderer — these assert the
 *  domain, so no view is mounted. */
async function setup(): Promise<Harness> {
  const t = await createTestRenderer({ width: 100, height: 30 })
  const paneHost = new BoxRenderable(t.renderer, {
    id: "pane-host",
    flexDirection: "row",
    flexGrow: 1,
  })
  t.renderer.root.add(paneHost)

  const spaces = new SpaceSet(t.renderer, paneHost, SHELL)
  const space = spaces.create("proj", process.cwd())
  space.workspace.init("shell")

  return {
    t,
    spaces,
    space,
    ws: space.workspace,
    async dispose() {
      spaces.disposeAll()
      await Bun.sleep(50) // let PTY pumps observe the kill and settle
      t.renderer.destroy()
    },
  }
}

test("an agent with no view is detached but keeps running", async () => {
  const s = await setup()
  try {
    const bg = s.ws.spawn("background", ["sleep", "30"])
    expect(bg.viewers).toBe(0)
    expect(s.ws.detached).toContain(bg)

    s.ws.reveal(bg)
    expect(bg.viewers).toBe(1)
    expect(s.ws.detached).not.toContain(bg)
  } finally {
    await s.dispose()
  }
})

test("output on a detached agent marks it unseen", async () => {
  const s = await setup()
  try {
    const chatter = s.ws.spawn("chatter", ["sh", "-c", "echo hello-from-detached; sleep 5"])
    await Bun.sleep(400)
    expect(chatter.unseen).toBe(true)
    // Opening a view is what clears it.
    s.ws.reveal(chatter)
    expect(chatter.unseen).toBe(false)
  } finally {
    await s.dispose()
  }
})

test("killing an agent removes it and leaves the others alone", async () => {
  const s = await setup()
  try {
    const killme = s.ws.spawn("killme", ["sleep", "30"])
    const keep = s.ws.spawn("keep", ["sleep", "30"])
    s.ws.killAgent(killme)
    expect(s.ws.agents).not.toContain(killme)
    expect(s.ws.agents).toContain(keep)
  } finally {
    await s.dispose()
  }
})

test("scrolled reflects the real viewport, including past both edges", async () => {
  const s = await setup()
  try {
    // Real scrollback is required: `scrolled` is read back from ghostty's
    // viewport, so scrolling a terminal with no history is correctly a no-op.
    const bg = s.ws.spawn("scrolly", ["sh", "-c", "seq 1 200; sleep 30"])
    await Bun.sleep(400)
    expect(bg.scrolled).toBe(false)

    bg.scrollBy(-5)
    expect(bg.scrolled).toBe(true)
    bg.scrollToBottom()
    expect(bg.scrolled).toBe(false)

    bg.scrollBy(5) // down while already at the bottom: a no-op, not "scrolled"
    expect(bg.scrolled).toBe(false)

    // Past the top and all the way back. A locally tracked offset over-counts
    // here and never returns to the bottom; the viewport read-back stays honest.
    bg.scrollBy(-9999)
    expect(bg.scrolled).toBe(true)
    bg.scrollBy(9999)
    expect(bg.scrolled).toBe(false)
  } finally {
    await s.dispose()
  }
})

test("each space keeps its own layout and agents across activation", async () => {
  const s = await setup()
  try {
    const other = s.spaces.create("other", process.cwd())
    other.workspace.init("shell")
    other.workspace.split("row")
    expect(other.workspace.panes.length).toBe(2)
    expect(s.ws.panes.length).toBe(1)

    // Activating swaps the whole pane area over; the inactive space keeps its
    // split tree and its agents rather than being torn down.
    s.spaces.activate(other)
    expect(s.spaces.active).toBe(other)
    expect(s.ws.panes.length).toBe(1)
    expect(s.ws.agents.length).toBe(1)

    s.spaces.activate(s.space)
    expect(other.workspace.panes.length).toBe(2)
    expect(other.agents.length).toBe(2)
  } finally {
    await s.dispose()
  }
})

test("a space's state is the most urgent state among its agents", async () => {
  const s = await setup()
  try {
    await Bun.sleep(300)
    expect(s.space.state).toBe("idle")

    const agent = s.ws.agents[0]!
    agent.write("sleep 5\n")
    await Bun.sleep(400)
    expect(agent.state).toBe("working")
    // Working beats the idle agents around it.
    expect(s.space.state).toBe("working")
  } finally {
    await s.dispose()
  }
})

test("a pane closes when its agent's process exits, and the agent stays as done", async () => {
  const s = await setup()
  try {
    const pane = s.ws.split("row", s.ws.spawn("shortlived", ["sh", "-c", "echo bye; exit 0"]))
    expect(pane).not.toBeNull()
    expect(s.ws.panes.length).toBe(2)

    await Bun.sleep(600)
    // The view is gone so the layout reclaims the space...
    expect(s.ws.panes.length).toBe(1)
    // ...but the agent is still listed, exited, with its output still readable.
    const agent = s.ws.agents.find((a) => a.name === "shortlived")
    expect(agent).toBeDefined()
    expect(agent!.state).toBe("done")
    expect(s.ws.detached).toContain(agent!)
  } finally {
    await s.dispose()
  }
})

test("a finished agent does not make its space look finished", async () => {
  const s = await setup()
  try {
    s.ws.spawn("shortlived", ["sh", "-c", "exit 0"])
    await Bun.sleep(500)
    // One agent is done, the seeded shell is still alive at its prompt.
    expect(s.ws.agents.some((a) => a.state === "done")).toBe(true)
    expect(s.space.state).toBe("idle")
  } finally {
    await s.dispose()
  }
})
