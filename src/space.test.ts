import { test, expect } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Divider } from "./divider.ts"
import { SpaceSet, rollUp, type Space } from "./space.ts"
import type { Window } from "./window.ts"
import type { Agent, AgentState } from "./agent.ts"

const SHELL = ["bash"]

interface Harness {
  t: TestRendererSetup
  spaces: SpaceSet
  space: Space
  win: Window
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
  const win = space.newWindow()
  win.init("shell")

  return {
    t,
    spaces,
    space,
    win,
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
    const bg = s.win.spawn("background", ["sleep", "30"])
    expect(bg.viewers).toBe(0)
    expect(s.win.detached).toContain(bg)

    s.win.reveal(bg)
    expect(bg.viewers).toBe(1)
    expect(s.win.detached).not.toContain(bg)
  } finally {
    await s.dispose()
  }
})

test("output on a detached agent marks it unseen", async () => {
  const s = await setup()
  try {
    const chatter = s.win.spawn("chatter", ["sh", "-c", "echo hello-from-detached; sleep 5"])
    await Bun.sleep(400)
    expect(chatter.unseen).toBe(true)
    // Opening a view is what clears it.
    s.win.reveal(chatter)
    expect(chatter.unseen).toBe(false)
  } finally {
    await s.dispose()
  }
})

test("killing an agent removes it and leaves the others alone", async () => {
  const s = await setup()
  try {
    const killme = s.win.spawn("killme", ["sleep", "30"])
    const keep = s.win.spawn("keep", ["sleep", "30"])
    s.win.killAgent(killme)
    expect(s.win.agents).not.toContain(killme)
    expect(s.win.agents).toContain(keep)
  } finally {
    await s.dispose()
  }
})

test("scrolled reflects the real viewport, including past both edges", async () => {
  const s = await setup()
  try {
    // Real scrollback is required: `scrolled` is read back from ghostty's
    // viewport, so scrolling a terminal with no history is correctly a no-op.
    const bg = s.win.spawn("scrolly", ["sh", "-c", "seq 1 200; sleep 30"])
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

test("each space keeps its own windows and layouts across activation", async () => {
  const s = await setup()
  try {
    const other = s.spaces.create("other", process.cwd())
    const otherWin = other.newWindow()
    otherWin.init("shell")
    otherWin.split("row")
    expect(otherWin.panes.length).toBe(2)
    expect(s.win.panes.length).toBe(1)

    // Activating swaps the whole pane area over; the inactive space keeps its
    // windows, their split trees and their agents rather than being torn down.
    s.spaces.activate(other)
    expect(s.spaces.active).toBe(other)
    expect(s.win.panes.length).toBe(1)
    expect(s.win.agents.length).toBe(1)

    s.spaces.activate(s.space)
    expect(otherWin.panes.length).toBe(2)
    expect(otherWin.agents.length).toBe(2)
  } finally {
    await s.dispose()
  }
})

test("a space of plain shells is idle, and an exited one still reads as idle", async () => {
  // Shells have no agent state to report, so the space stays idle no matter
  // what they are running — see the note on Agent.state.
  const s = await setup()
  try {
    await Bun.sleep(300)
    expect(s.space.state).toBe("idle")

    const agent = s.win.agents[0]!
    agent.write("sleep 5\n")
    await Bun.sleep(400)
    expect(agent.state).toBe("idle")
    expect(s.space.state).toBe("idle")
  } finally {
    await s.dispose()
  }
})

test("a roll-up reports the most urgent state present, and 'done' never wins", () => {
  const stub = (state: AgentState) => ({ state }) as unknown as Agent
  expect(rollUp([])).toBe("done")
  expect(rollUp([stub("idle"), stub("working"), stub("done")])).toBe("working")
  expect(rollUp([stub("working"), stub("blocked")])).toBe("blocked")
  // One finished agent must not make a space with live agents look finished.
  expect(rollUp([stub("done"), stub("idle")])).toBe("idle")
  expect(rollUp([stub("done"), stub("done")])).toBe("done")
})

test("a pane closes when its agent's process exits, and the agent stays as done", async () => {
  const s = await setup()
  try {
    const pane = s.win.split("row", s.win.spawn("shortlived", ["sh", "-c", "echo bye; exit 0"]))
    expect(pane).not.toBeNull()
    expect(s.win.panes.length).toBe(2)

    await Bun.sleep(600)
    // The view is gone so the layout reclaims the space...
    expect(s.win.panes.length).toBe(1)
    // ...but the agent is still listed, exited, with its output still readable.
    const agent = s.win.agents.find((a) => a.name === "shortlived")
    expect(agent).toBeDefined()
    expect(agent!.state).toBe("done")
    expect(s.win.detached).toContain(agent!)
  } finally {
    await s.dispose()
  }
})

test("a finished agent does not make its space look finished", async () => {
  const s = await setup()
  try {
    s.win.spawn("shortlived", ["sh", "-c", "exit 0"])
    await Bun.sleep(500)
    // One agent is done, the seeded shell is still alive at its prompt.
    expect(s.win.agents.some((a) => a.state === "done")).toBe(true)
    expect(s.space.state).toBe("idle")
  } finally {
    await s.dispose()
  }
})

test("windows keep separate agents and layouts within one space", async () => {
  const s = await setup()
  try {
    s.win.spawn("alpha", ["sleep", "30"])
    const second = s.space.newWindow("build")
    second.init("shell")
    second.split("row")

    expect(s.space.windows.length).toBe(2)
    expect(s.space.active).toBe(second)
    // Agents belong to the window they were started in, not to the space.
    expect(s.win.agents.length).toBe(2)
    expect(second.agents.length).toBe(2)
    expect(s.space.agents.length).toBe(4)
    // Switching back restores the first window's layout untouched.
    s.space.selectWindow(s.win)
    expect(s.win.panes.length).toBe(1)
    expect(second.panes.length).toBe(2)
  } finally {
    await s.dispose()
  }
})

test("windows are selectable by their stable number", async () => {
  const s = await setup()
  try {
    const second = s.space.newWindow()
    second.init("shell")
    const third = s.space.newWindow()
    third.init("shell")
    expect([s.win.number, second.number, third.number]).toEqual([1, 2, 3])

    // Closing a middle window must not renumber the others, or ^a 3 would
    // start selecting a different window than it did a moment ago.
    s.space.closeWindow(second)
    expect(s.space.selectNumber(3)).toBe(true)
    expect(s.space.active).toBe(third)
    expect(s.space.selectNumber(2)).toBe(false)
  } finally {
    await s.dispose()
  }
})

test("closing a window stops the agents that live in it", async () => {
  const s = await setup()
  try {
    const second = s.space.newWindow()
    second.init("shell")
    const doomed = second.spawn("doomed", ["sleep", "60"])
    expect(doomed.exited).toBe(false)

    s.space.closeWindow(second)
    await Bun.sleep(300)
    expect(s.space.windows).not.toContain(second)
    expect(s.space.agents).not.toContain(doomed)
  } finally {
    await s.dispose()
  }
})

test("a window's title falls back to what it is running", async () => {
  const s = await setup()
  try {
    expect(s.win.title.length).toBeGreaterThan(0)
    s.win.customName = "editor"
    expect(s.win.title).toBe("editor")
    // Clearing the name hands it back to the running agent.
    s.win.customName = null
    expect(s.win.title).not.toBe("editor")
  } finally {
    await s.dispose()
  }
})

test("splitting inserts a draggable divider that resizes its neighbours", async () => {
  const s = await setup()
  try {
    const pane = s.win.split("row")
    expect(pane).not.toBeNull()

    const children = s.win.root.getChildren()
    // pane, divider, pane — the divider is a real renderable, so OpenTUI's hit
    // grid resolves drags onto it without any rect math of ours.
    expect(children.length).toBe(3)
    const divider = children[1] as any
    expect(divider.axis).toBe("row")
    expect(divider.width).toBe(1)

    await s.t.renderOnce()
    const [left, right] = [children[0] as any, children[2] as any]
    const total = left.width + right.width
    const startX = divider.x

    // Simulate a fast drag that jumps clear of the divider in one event: the
    // resize is computed from where the pointer is, not from accumulated
    // deltas, so overshooting still lands where asked.
    divider.onMouseEvent({ type: "down", x: startX, y: divider.y, button: 0, stopPropagation() {} })
    divider.onMouseEvent({ type: "drag", x: startX - 10, y: divider.y, button: 0, stopPropagation() {} })
    await s.t.renderOnce()

    expect(left.width).toBe(total - right.width)
    expect(left.width).toBeLessThan(total / 2)
  } finally {
    await s.dispose()
  }
})

test("a divider cannot be dragged past its neighbour", async () => {
  const s = await setup()
  try {
    s.win.split("row")
    const children = s.win.root.getChildren()
    const divider = children[1] as any
    await s.t.renderOnce()
    const [left, right] = [children[0] as any, children[2] as any]
    const total = left.width + right.width

    divider.onMouseEvent({ type: "down", x: divider.x, y: divider.y, button: 0, stopPropagation() {} })
    divider.onMouseEvent({ type: "drag", x: divider.x + 9999, y: divider.y, button: 0, stopPropagation() {} })
    await s.t.renderOnce()

    // The neighbour keeps a usable minimum rather than collapsing to nothing.
    expect(right.width).toBeGreaterThan(0)
    expect(left.width + right.width).toBe(total)
  } finally {
    await s.dispose()
  }
})

test("closing a pane takes its divider with it", async () => {
  const s = await setup()
  try {
    const pane = s.win.split("row")!
    expect(s.win.root.getChildren().length).toBe(3)

    s.win.close(pane)
    // A leftover divider would render as a border against nothing.
    const children = s.win.root.getChildren()
    expect(children.length).toBe(1)
    expect(children[0]).toBe(s.win.panes[0])
  } finally {
    await s.dispose()
  }
})

test("splitting a resized pane gives the newcomer half of it, not a sliver", async () => {
  const s = await setup()
  try {
    s.win.split("row")
    await s.t.renderOnce()
    const rootKids = () => s.win.root.getChildren() as any[]

    // Resize so the panes are lopsided, which is what exposed the bug: the
    // divider stores weights as cell counts, and a fresh pane used to arrive
    // weighted 1 against a neighbour weighted ~70.
    const divider = rootKids()[1]
    divider.onMouseEvent({ type: "down", x: divider.x, y: divider.y, button: 0, stopPropagation() {} })
    divider.onMouseEvent({ type: "drag", x: divider.x - 20, y: divider.y, button: 0, stopPropagation() {} })
    await s.t.renderOnce()
    const [leftBefore, , rightBefore] = rootKids().map((k) => k.width)

    s.win.split("row")
    await s.t.renderOnce()

    // The outer split is untouched...
    const [leftAfter, , rightAfter] = rootKids().map((k) => k.width)
    expect(leftAfter).toBe(leftBefore)
    expect(rightAfter).toBe(rightBefore)

    // ...and the new pane took half of the pane it split, not a cell or two.
    const box = rootKids()[2]
    const inner = (box.getChildren() as any[]).map((k) => k.width)
    expect(inner.length).toBe(3)
    expect(inner[0]).toBeGreaterThan(rightBefore / 3)
    expect(inner[2]).toBeGreaterThan(rightBefore / 3)
  } finally {
    await s.dispose()
  }
})

test("a pane draws only the edges facing the window, never one a divider covers", async () => {
  const s = await setup()
  try {
    // One pane owns the whole frame.
    const only = s.win.panes[0]!
    expect(only.edges).toEqual({ top: true, right: true, bottom: true, left: true })

    // Split left/right: the seam between them belongs to the divider, so
    // neither pane draws a border there and the frame stays one cell thick.
    const right = s.win.split("row")!
    const left = s.win.panes[0]!
    expect(left.edges).toEqual({ top: true, right: false, bottom: true, left: true })
    expect(right.edges).toEqual({ top: true, right: true, bottom: true, left: false })

    // Split the right pane top/bottom. Its halves inherit the missing left
    // edge from the box that replaced it — the walk has to go up the tree, not
    // just look at immediate siblings.
    const bottom = s.win.split("column")!
    expect(right.edges).toEqual({ top: true, right: true, bottom: false, left: false })
    expect(bottom.edges).toEqual({ top: false, right: true, bottom: true, left: false })

    // Closing the survivor's neighbour hands its edges back.
    s.win.close(bottom)
    expect(right.edges).toEqual({ top: true, right: true, bottom: true, left: false })
  } finally {
    await s.dispose()
  }
})

test("a divider caps its ends against the frame and tees into other dividers", async () => {
  const s = await setup()
  try {
    s.win.split("row")
    const vertical = s.win.root.getChildren()[1] as Divider
    // Runs the full height of the window, so both ends meet the outer border.
    expect([vertical.capStart, vertical.capEnd]).toEqual([true, true])

    // A horizontal split of the right-hand pane sits inside it: its left end
    // runs into the vertical divider rather than the frame.
    s.win.split("column")
    const box = s.win.root.getChildren()[2] as BoxRenderable
    const horizontal = box.getChildren()[1] as Divider
    expect(horizontal.axis).toBe("column")
    expect([horizontal.capStart, horizontal.capEnd]).toEqual([false, true])
  } finally {
    await s.dispose()
  }
})

test("the focused pane's shared border highlights with it", async () => {
  const s = await setup()
  try {
    const right = s.win.split("row")!
    const divider = s.win.root.getChildren()[1] as Divider
    // The seam is the focused pane's border too, so it lights up with it.
    expect(divider.adjacentToFocus).toBe(true)

    // Still adjacent from the other side.
    s.win.focus(s.win.panes[0]!)
    expect(divider.adjacentToFocus).toBe(true)

    // Focus a pane in a nested box: the divider two levels up is no longer
    // touching the focused pane directly, but it still bounds the subtree.
    s.win.focus(right)
    const deep = s.win.split("column")!
    expect(divider.adjacentToFocus).toBe(true)
    const inner = (s.win.root.getChildren()[2] as BoxRenderable).getChildren()[1] as Divider
    expect(inner.adjacentToFocus).toBe(true)
    expect(deep.edges.left).toBe(false)
  } finally {
    await s.dispose()
  }
})
