/** @jsxImportSource @opentui/solid */
import { scopedSpaceSet } from "../harness.ts"
import { afterEach, test, expect } from "bun:test"
import { Effect } from "effect"
import { createSignal } from "solid-js"
import { BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { render } from "@opentui/solid"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SpaceSet } from "../space.ts"
import { createAppState, POLL_MS } from "./state.ts"
import { Sidebar, sidebarTargets, SIDEBAR_WIDTH, clampSidebarSelection } from "./Sidebar.tsx"
import { SessionDaemon } from "../daemon.ts"
import { SessionClient, type SessionClientShape } from "../client.ts"
import { SessionEnv } from "../session.ts"
import type { SpawnBackend } from "../backend.ts"
import { workspaceEnv } from "../env.ts"

const SHELL = ["bash"]

const daemons: SessionDaemon[] = []
const clients: SessionClientShape[] = []
const dirs: string[] = []
const run = <A,>(effect: Effect.Effect<A, unknown, SessionEnv>, env: NodeJS.ProcessEnv) => Effect.runPromise(effect.pipe(Effect.provideService(SessionEnv, env)))
afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => {})
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * Wait for a mouse dispatch to land.
 *
 * mockMouse writes the escape sequence to the renderer's stdin and waits a
 * fixed 10ms; parsing, hit-testing and dispatch happen on the renderer's own
 * schedule after that. Ten milliseconds is plenty when this file runs alone and
 * not always enough once a full suite's worth of renderers share the loop, so
 * asserting straight after a click is a race that only shows up under load.
 * Poll for the effect instead of assuming it has already happened.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** waitFor, for predicates that have to ask a process (the daemon). */
async function waitForAsync(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function setup(backend?: SpawnBackend, agentsOnly = false) {
  const [selected, setSelected] = createSignal(0)
  const [hovered, setHovered] = createSignal<number | null>(null)
  const activated: number[] = []

  // Renderer and domain first, then mount Solid into that same renderer —
  // Solid's render() accepts an existing CliRenderer, which is also how the
  // real app hosts the imperative pane tree alongside the reactive chrome.
  const t = await createTestRenderer({ width: 60, height: 20 })
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 })
  const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer, { shell: SHELL, backend }), paneHost)
  const space = Effect.runSync(spaces.create("proj", process.cwd()))
  const win = Effect.runSync(space.newWindow())
  Effect.runSync(win.init("shell"))
  const app = createAppState(spaces)

  await render(
    () => (
      // Height-constrained exactly as App.tsx constrains it. Mounted bare, the
      // sidebar is the render root with no height to fill, so its flexGrow
      // scrollbox takes every row and anything below it is pushed off-screen —
      // which silently hid the footer here, and would hide anything else the
      // sidebar ever puts at its bottom.
      <box style={{ width: "100%", height: "100%", flexDirection: "row" }}>
        <Sidebar
          app={app}
          width={30}
          selected={selected()}
          hovered={hovered()}
          focused={false}
          agentsOnly={agentsOnly}
          onHover={setHovered}
          onActivate={(i) => activated.push(i)}
        />
      </box>
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
      app.dispose()
      await Bun.sleep(50)
      t.renderer.destroy()
    },
  }
}

test("agents-only filtering removes plain panes and empty parents", async () => {
  const s = await setup(undefined, true)
  try {
    Effect.runSync(s.win.spawn("claude", ["claude"]))
    const empty = Effect.runSync(s.space.newWindow("empty"))
    Effect.runSync(empty.init("shell"))
    s.spaces.onChange?.()

    await s.t.waitForFrame((f) => f.includes("claude"))
    const frame = s.t.captureCharFrame()
    expect(frame).toContain("claude")
    expect(frame).not.toContain("2:empty")
    const targets = sidebarTargets(s.spaces.spaces, true)
    expect(targets.map((target) => target.kind)).toEqual([
      "space",
      "window",
      "agent",
    ])
    expect(targets.at(-1)).toMatchObject({ kind: "agent", agent: { title: "claude" } })
  } finally {
    await s.dispose()
  }
})

test("selection is clamped when polled rows disappear", () => {
  expect(clampSidebarSelection(4, 2)).toBe(1)
  expect(clampSidebarSelection(4, 0)).toBe(0)
})

test("renders the space/agent tree with a state glyph per row", async () => {
  const s = await setup()
  try {
    await s.t.waitForFrame((f: string) => f.includes("proj"))
    const frame = s.t.captureCharFrame()
    // The tree now starts on the first row: the summary that used to sit above
    // it is what this change moved out of the way.
    expect(frame.split("\n")[0]).toContain("proj")
    // And it is still rendered, below the tree rather than above it.
    expect(frame).toContain("1 space · 1 agent")
    expect(frame).toMatch(/[○●✓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    expect(frame).not.toContain("toggles sidebar")
  } finally {
    await s.dispose()
  }
})

/**
 * The footer counts what the tree shows.
 *
 * ts-9beb5d: the tree gained its second window and the header its second tab,
 * while the footer went on saying "1 agent". A summary that disagrees with the
 * rows directly above it is worse than no summary, and the blocked count is the
 * whole premise of ^a a — a badge that never appears is the failure mode that
 * matters.
 */
test("the footer counter follows the tree", async () => {
  const s = await setup()
  try {
    await s.t.waitForFrame((f: string) => f.includes("1 space · 1 agent"))

    const second = Effect.runSync(s.space.newWindow())
    Effect.runSync(second.init("shell"))

    await s.t.waitForFrame((f: string) => f.includes("1 space · 2 agents"))
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

test("an agent with no pane open shows the ⇠ indicator", async () => {
  const s = await setup()
  try {
    Effect.runSync(s.win.spawn("background", ["sleep", "30"]))
    s.spaces.onChange?.()
    await s.t.waitForFrame((f: string) => f.includes("⇠"))
    expect(s.t.captureCharFrame()).toContain("background")
  } finally {
    await s.dispose()
  }
})

/**
 * The real deployment path, end to end: a daemon owns the process, the client
 * views it, and the sidebar reads its state through the daemon backend. When
 * the daemon goes away the *attachment* ends but the process does not, so the
 * agent must stay rendered as detached (⊘), not as idle (○) or finished (✓) — the
 * exit code is null precisely so the sidebar has something to tell apart, see
 * backend.ts.
 */
test("an agent whose daemon attachment is lost is distinct from idle and done", async () => {
  const home = await mkdtemp(join(tmpdir(), "herdr-sidebar-"))
  dirs.push(home)
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv
  const daemon = await run(SessionDaemon.open("sidebar-detach"), env)
  daemons.push(daemon)
  await daemon.start()
  const client = await run(SessionClient.connect("sidebar-detach", { client: "ui", autostart: false }), env)
  clients.push(client)

  const s = await setup(client.backend())
  try {
    const agent = s.win.agents[0]!
    // The spawn is a round trip over RPC; stopping the daemon before it lands
    // would end nothing, so first wait for the daemon to own the agent.
    await waitForAsync(
      () => daemon.liveAgents().then((ids) => ids.includes(agent.id)),
      "the daemon to own the agent",
    )
    await s.t.waitForFrame((f: string) => f.includes("shell"))

    const live = s.t.captureCharFrame()
    expect(live).toContain("shell")
    expect(live).toContain("○")
    expect(live).not.toContain("✓")

    // The daemon dies: its agents are killed by the same move, but from this
    // client's side it is a lost attachment, never an exit frame.
    await daemon.stop()

    await waitForAsync(() => agent.detached === true, "the agent to detach")
    expect(agent.exited).toBe(false)
    expect(agent.exitCode).toBeNull()
    expect(agent.state).toBe("detached")

    // The sidebar polls state, so give it a few ticks after the detach; every
    // Repaint must keep showing it as detached, never flip it to idle or done.
    await waitFor(() => s.t.captureCharFrame().includes("⊘"), "the detached glyph to render")
    const deadline = Date.now() + 3 * POLL_MS + 50
    while (Date.now() < deadline) {
      const frame = s.t.captureCharFrame()
      expect(frame).toContain("⊘")
      expect(frame).not.toContain("✓")
      await Bun.sleep(10)
    }
    expect(s.t.captureCharFrame()).toContain("shell")
  } finally {
    await s.dispose()
  }
})

/**
 * The bug this guards against: an agent row's label is "command · title", and
 * the text renderable truncates at the row's right edge — so the *command* must
 * lead, or a shell's long OSC title (a cwd, which the space row already shows)
 * eats the whole label area and the command is always truncated away.
 */
test("a long OSC title is truncated so the foreground command stays visible", async () => {
  const s = await setup()
  try {
    const agent = s.win.agents[0]!
    // Put a process in the foreground so the row has a command to show. The
    // shell needs a moment to be running before it will execute what we type.
    agent.write("sleep 30\n")
    await waitFor(() => agent.foregroundCommand === "sleep", "the foreground command")
    // A shell-style OSC title, longer than the 25-char label area at 30 cols.
    agent.term.write(new TextEncoder().encode("\x1b]2;dan@host:~/build/opentui-herdr\x07"))

    // waitForFrame, not waitForFrame's predicate: the mutation lands between two
    // of the sidebar's POLL_MS repaints, and waitForFrame gives up as soon as
    // the renderer is momentarily idle — which is exactly that gap. Poll the
    // rendered buffer until a repaint has caught up with the title change.
    await waitFor(() => s.t.captureCharFrame().includes("sleep ·"), "the command to lead the label")
    const frame = s.t.captureCharFrame()
    // The command leads the label, so truncation cuts the title tail, not it.
    expect(frame).toContain("sleep · dan@")
    expect(frame).not.toContain("dan@host:~/build/opentui-herdr · sleep")
  } finally {
    await s.dispose()
  }
})

test("hover follows the pointer between rows, not just on entry", async () => {
  const s = await setup()
  try {
    Effect.runSync(s.win.spawn("alpha", ["sleep", "30"]))
    Effect.runSync(s.win.spawn("beta", ["sleep", "30"]))
    s.spaces.onChange?.()
    await s.t.waitForFrame((f: string) => f.includes("beta"))

    // OpenTUI emits "over" once on entry and "move" for every position after
    // that inside the same renderable; handling both is what makes the
    // highlight track the pointer instead of sticking to the entry row.
    await s.t.mockMouse.moveTo(10, 0)
    await waitFor(() => s.hovered() === 0, "hover on the space row")
    await s.t.mockMouse.moveTo(10, 2)
    await waitFor(() => s.hovered() === 2, "hover to move down two rows")
    await s.t.mockMouse.moveTo(10, 1)
    await waitFor(() => s.hovered() === 1, "hover to move back up one row")
  } finally {
    await s.dispose()
  }
})

test("clicking a row reports its selectable index, skipping the branch line", async () => {
  const s = await setup()
  try {
    s.space.branch = "main"
    Effect.runSync(s.win.spawn("clickme", ["sleep", "30"]))
    s.spaces.onChange?.()
    await s.t.waitForFrame((f: string) => f.includes("clickme"))

    // Rows: 0 space(index 0), 1 branch(not selectable), 2 window(1),
    // 3 shell(2), 4 clickme(3). The branch line has no handler, so clicking it
    // is inert.
    //
    // The branch click is proven inert by what follows it rather than by an
    // immediate empty assertion: clicking the window row next and waiting for
    // exactly one activation shows the branch click never produced one, and
    // does not depend on how promptly a dispatch that should never happen
    // fails to happen.
    // The sidebar can repaint while the POLL_MS timer updates agent state. A
    // click during that repaint can hit-test against a row renderable Solid
    // has just replaced; the event then resolves to nothing and is dropped.
    // Synchronize with the renderer rather than guessing how long a repaint
    // takes; see ts-946056.
    await s.t.waitForVisualIdle()
    await s.t.mockMouse.click(10, 1)
    await s.t.waitForVisualIdle()
    await s.t.mockMouse.click(10, 2)
    await waitFor(() => s.activated.length >= 1, "the window row activation")
    expect(s.activated).toEqual([1]) // the window row, and nothing for the branch

    await s.t.mockMouse.click(10, 4)
    await waitFor(() => s.activated.length >= 2, "the agent row activation")
    expect(s.activated).toEqual([1, 3]) // clickme, under that window
  } finally {
    await s.dispose()
  }
})

test("windows nest between the space and its agents", async () => {
  const s = await setup()
  try {
    Effect.runSync(s.win.spawn("alpha", ["sleep", "30"]))
    const second = Effect.runSync(s.space.newWindow("build"))
    Effect.runSync(second.init("shell"))
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
    Effect.runSync(s.win.splitSpawn("row")) // the newcomer (bash) takes focus, so the tab reads 1:bash
    await s.t.waitForFrame((f: string) => f.includes("1:bash"))

    // No manual refresh: breakPane must drive the repaint itself, the way any
    // structural change does — this is the "tabs update" half of the contract.
    await Effect.runPromise(s.space.breakPane(s.win.panes[1]!))

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

/** The scrollbox Solid created for the sidebar. */
function findScrollBox(root: unknown): ScrollBoxRenderable | null {
  if (!root) return null
  const renderable = root as { constructor?: { name?: string }; getChildren?: () => unknown[] }
  if (renderable.constructor?.name === "ScrollBoxRenderable") return root as ScrollBoxRenderable
  for (const child of renderable.getChildren?.() ?? []) {
    const found = findScrollBox(child)
    if (found) return found
  }
  return null
}

/**
 * The bug this guards against: the scrollbox's horizontal scrollbar is laid out
 * as a one-row flex child before its visibility recalculates, so on the first
 * pass the viewport reads one row short of the tree. A tree that exactly fits
 * then looks like overflow, and the vertical scrollbar flashes a full-column
 * thumb in the seam-adjacent column — a stray vertical mark against the frame.
 * The sidebar never scrolls horizontally (rows truncate at the sidebar width),
 * so hiding the horizontal scrollbar keeps the viewport full-height from the
 * first layout pass.
 */
test("a tree that fits shows no scrollbar thumb beside the seam, even on the first frame", async () => {
  const s = await setup()
  try {
    // No waitForFrame, no waitForVisualIdle: the phantom thumb lives in the
    // first layout pass and is gone by the time the layout settles.
    await s.t.renderOnce()
    const frame = s.t.captureCharFrame()
    const seamColumn = SIDEBAR_WIDTH - 1
    const thumb = frame
      .split("\n")
      .map((l, i) => ({ i, c: l[seamColumn] ?? "" }))
      .filter((x) => x.c !== " " && x.c !== "")
    expect(thumb).toEqual([])
    const scrollBox = findScrollBox(s.t.renderer.root)
    expect(scrollBox?.verticalScrollBar.visible).toBe(false)
  } finally {
    await s.dispose()
  }
})

/**
 * The other half of the same contract: the fix hides a scrollbar that is never
 * used, but the vertical scrollbar must still appear while the tree really
 * overflows, and disappear again once it fits. A tree this tall needs a
 * height-constrained sidebar, or the scrollbox grows with its content and never
 * has anything to scroll.
 */
test("the seam shows a thumb only while the tree overflows", async () => {
  const [selected, setSelected] = createSignal(0)
  const [hovered, setHovered] = createSignal<number | null>(null)

  const t = await createTestRenderer({ width: 60, height: 20 })
  const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 })
  const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer, { shell: SHELL }), paneHost)
  const space = Effect.runSync(spaces.create("proj", process.cwd()))
  const win = Effect.runSync(space.newWindow())
  Effect.runSync(win.init("shell"))
  const app = createAppState(spaces)

  // A row-flex wrapper stretches the sidebar to a fixed height, the way the
  // real app's pane row does, so the scrollbox viewport cannot grow with the
  // tree.
  await render(
    () => (
      <box style={{ width: SIDEBAR_WIDTH, height: 20, flexDirection: "row" }}>
        <Sidebar
          app={app}
          width={SIDEBAR_WIDTH}
          selected={selected()}
          hovered={hovered()}
          focused={false}
          agentsOnly={false}
          onHover={setHovered}
          onActivate={() => {}}
        />
      </box>
    ),
    t.renderer,
  )

  try {
    const scrollBar = () => findScrollBox(t.renderer.root)?.verticalScrollBar

    await t.waitForVisualIdle()
    expect(scrollBar()?.visible).toBe(false)

    // The viewport is 18 rows (20 minus summary and footer); push the tree past
    // it and the scrollbar must come up. The summary's agent count is the frame
    // signal to wait on — a spawned label sits below the fold once it scrolls.
    const seamChars = (frame: string) =>
      frame
        .split("\n")
        .map((l) => l[SIDEBAR_WIDTH - 1] ?? "")
        .filter((c) => c !== " " && c !== "")
    for (let i = 0; i < 18; i++) Effect.runSync(win.spawn(`g${i}`, ["sleep", "30"]))
    spaces.onChange?.()
    await waitFor(() => t.captureCharFrame().includes("19 agents"), "the grown tree to render")
    expect(scrollBar()?.visible).toBe(true)

    // Kill the extras; the tree fits again and the thumb must go.
    for (let i = 0; i < 18; i++) await Effect.runPromise(win.killAgent(win.agents[win.agents.length - 1]!))
    spaces.onChange?.()
    await waitFor(() => t.captureCharFrame().includes("1 agent"), "the tree to shrink back")
    expect(scrollBar()?.visible).toBe(false)
    expect(seamChars(t.captureCharFrame()).join("")).not.toMatch(/[█▀▄▌▐]/)
  } finally {
    app.dispose()
    await Bun.sleep(50)
    t.renderer.destroy()
  }
})
