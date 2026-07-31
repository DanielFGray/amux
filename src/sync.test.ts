import { test, expect, spyOn, afterEach } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { SpaceSet } from "./space.ts"
import { setWeight } from "./divider.ts"
import { createBindings } from "./bindings.ts"
import { encodeKey } from "./keys.ts"
import { RenderState } from "./ghostty.ts"
import type { Window } from "./window.ts"
import { Agent } from "./agent.ts"

const SHELL = ["bash"]

const cleanup: (() => void)[] = []
const spies: ReturnType<typeof spyOn>[] = []
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
  for (const fn of cleanup.splice(0)) fn()
})

async function setup(opts?: { init?: boolean }): Promise<{
  t: TestRendererSetup
  spaces: SpaceSet
  window: Window
  layout: () => Promise<void>
}> {
  const t = await createTestRenderer({ width: 80, height: 24 })
  const host = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 })
  t.renderer.root.add(host)
  const spaces = new SpaceSet(t.renderer, host, SHELL)
  const space = spaces.create("proj", process.cwd())
  const window = space.newWindow()
  if (opts?.init !== false) window.init()
  cleanup.push(() => {
    spaces.disposeAll()
    t.renderer.destroy()
  })
  // Geometry comes from yoga, which only runs on a frame.
  return { t, spaces, window, layout: () => t.renderOnce() }
}

/** Intercept every child-input write and record which agent got which bytes. */
function captureAgentWrites() {
  const spy = spyOn(Agent.prototype, "write")
  spy.mockImplementation(() => {})
  spies.push(spy)
  return {
    spy,
    agents: () => spy.mock.contexts as Agent[],
    data: () =>
      spy.mock.calls.map(([d]) =>
        typeof d === "string" ? d : new TextDecoder().decode(d),
      ),
    clear: () => spy.mockClear(),
  }
}

async function waitFor(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await Bun.sleep(10)
  }
  throw new Error("waitFor: condition never became true")
}

/** The last few written lines of an agent's screen, for reading cat's echo. */
function screenText(agent: Agent): string {
  const state = new RenderState()
  try {
    state.update(agent.term)
    return state.tailText(3).join("\n")
  } finally {
    state.free()
  }
}

test("sync starts off, toggles per window, and marks the tab", async () => {
  const { window } = await setup()
  expect(window.sync).toBe(false)
  const base = window.label
  expect(base).not.toContain(" Y")

  window.toggleSync()
  expect(window.sync).toBe(true)
  expect(window.label).toBe(`${base} Y`)

  window.toggleSync()
  expect(window.sync).toBe(false)
  expect(window.label).toBe(base)
})

test("input goes to the focused pane alone, then to every pane once sync is on", async () => {
  const { window, layout } = await setup()
  const first = window.panes[0]!
  const second = window.split("row")!
  const third = window.split("row")!
  window.focus(second)
  await layout()

  // Give the panes different sizes — a broadcast is byte delivery into each
  // child's own terminal, so geometry must not change the fan-out.
  setWeight(first, 3)
  setWeight(second, 1)
  await layout()

  const writes = captureAgentWrites()
  try {
    // Off: only the focused pane.
    window.write("a")
    expect(writes.agents()).toEqual([second.agent])

    // On: every pane in the window, identical bytes.
    window.toggleSync()
    window.write("b")
    expect(new Set(writes.agents())).toEqual(
      new Set([first.agent, second.agent, third.agent]),
    )
    expect(writes.data().slice(-3)).toEqual(["b", "b", "b"])

    // Moving focus does not change the set.
    window.focus(first)
    window.write("c")
    expect(new Set(writes.agents().slice(-3))).toEqual(
      new Set([first.agent, second.agent, third.agent]),
    )
    expect(writes.data().slice(-3)).toEqual(["c", "c", "c"])

    // Off again: back to focused-only.
    window.toggleSync()
    window.write("d")
    expect(writes.agents().slice(-1)).toEqual([first.agent])
  } finally {
    writes.spy.mockRestore()
  }
})

test("binary and control bytes fan out untouched", async () => {
  const { window } = await setup()
  window.split("row")
  window.toggleSync()
  const writes = captureAgentWrites()
  try {
    window.write("\x03")
    window.write("\x1b")
    window.write("\x00\x01\x1b[")
    expect(writes.data()).toEqual([
      "\x03",
      "\x03",
      "\x1b",
      "\x1b",
      "\x00\x01\x1b[",
      "\x00\x01\x1b[",
    ])
  } finally {
    writes.spy.mockRestore()
  }
})

test("the prefix and bound herdr controls are consumed and never broadcast", async () => {
  const { t, window } = await setup()
  window.split("row")
  const writes = captureAgentWrites()
  try {
    const fired: string[] = []
    const commands = [
      {
        name: "window.synchronize-panes",
        key: "<leader>y",
        desc: "toggle sync",
        group: "windows",
        run: () => {
          fired.push("sync")
          window.toggleSync()
        },
      },
    ]
    const bindings = createBindings(t.renderer, commands, {
      onUnhandled: (event) => {
        const bytes = encodeKey(event)
        if (bytes !== null) window.write(bytes)
        return true
      },
    })

    // The prefix press arms the sequence; it must not reach a child.
    t.mockInput.pressKey("a", { ctrl: true })
    expect(writes.data()).toEqual([])
    expect(window.sync).toBe(false)

    // The bound toggle is app-owned; its keys must not reach a child either.
    t.mockInput.pressKey("y")
    expect(writes.data()).toEqual([])
    expect(fired).toEqual(["sync"])
    expect(window.sync).toBe(true)

    // An unbound key is child input, and now broadcasts to both panes.
    t.mockInput.pressKey("h")
    expect(writes.data()).toEqual(["h", "h"])
    expect(bindings.leader()).toBe("ctrl+a")
  } finally {
    writes.spy.mockRestore()
  }
})

test("a detached agent receives no broadcast until a view is opened on it", async () => {
  const { window } = await setup()
  const visible = window.split("row")!
  const hidden = window.spawn("hidden", ["sleep", "30"])
  window.toggleSync()
  const writes = captureAgentWrites()
  try {
    window.write("x")
    // The broadcast set is exactly the window's panes.
    expect(new Set(writes.agents())).toEqual(
      new Set(window.panes.map((p) => p.agent)),
    )
    expect(writes.agents()).not.toContain(hidden)

    // Opening a view makes it a pane, and it joins the fan-out.
    window.reveal(hidden)
    window.write("y")
    const after = writes.agents().slice(-3)
    expect(after).toContain(hidden)
    expect(new Set(after)).toEqual(new Set(window.panes.map((p) => p.agent)))
  } finally {
    writes.spy.mockRestore()
  }
})

test("two panes viewing one agent are one process: broadcast writes it once", async () => {
  const { window } = await setup()
  const shared = window.spawn("shared", ["sleep", "30"])
  window.split("row", shared)
  window.split("row", shared)
  expect(window.panes.filter((p) => p.agent === shared)).toHaveLength(2)
  window.toggleSync()
  const writes = captureAgentWrites()
  try {
    window.write("z")
    expect(writes.agents().filter((a) => a === shared)).toHaveLength(1)
  } finally {
    writes.spy.mockRestore()
  }
})

test("the fan-out set follows the layout: a split joins, a close leaves, a new window starts unsynced", async () => {
  const { window, spaces } = await setup()
  const first = window.panes[0]!
  const second = window.split("row")!
  window.toggleSync()
  const writes = captureAgentWrites()
  try {
    window.write("a")
    expect(new Set(writes.agents())).toEqual(new Set([first.agent, second.agent]))

    // Closing a pane drops it from the set.
    writes.clear()
    window.close(second)
    window.write("b")
    expect(writes.agents()).toEqual([first.agent])

    // A new window starts unsynced, whatever the old one was doing.
    const other = spaces.active!.newWindow()
    other.init()
    expect(other.sync).toBe(false)
    writes.clear()
    other.write("c")
    expect(writes.agents()).toEqual([other.panes[0]!.agent])
  } finally {
    writes.spy.mockRestore()
  }
})

test("pane-local mouse stays pane-local even while synced", async () => {
  const { window, layout } = await setup()
  const right = window.split("row")!
  window.toggleSync()
  // Negotiate SGR mouse reporting on the right pane's terminal, the way a
  // full-screen app would, so the click produces bytes at all.
  right.agent.term.write(new TextEncoder().encode("\x1b[?1002h\x1b[?1006h"))
  await layout()

  const writes = captureAgentWrites()
  try {
    writes.clear()
    ;(right as any).onMouseEvent({
      type: "down",
      x: right.x + (right.edges.left ? 1 : 0),
      y: right.y + (right.edges.top ? 1 : 0),
      button: 0,
      modifiers: {},
      stopPropagation() {},
    })
    // The click reached exactly the pane under the pointer — no fan-out.
    expect(writes.agents()).toEqual([right.agent])
  } finally {
    writes.spy.mockRestore()
  }
})

test("broadcast input actually reaches every child process", async () => {
  const { window } = await setup({ init: false })
  const a = window.spawn("a", ["cat"])
  const b = window.spawn("b", ["cat"])
  window.split("row", a)
  window.split("row", b)
  window.toggleSync()
  window.write("hello-sync\n")
  await waitFor(() => screenText(a).includes("hello-sync") && screenText(b).includes("hello-sync"))
})
