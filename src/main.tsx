/** @jsxImportSource @opentui/solid */
import {
  createCliRenderer,
  BoxRenderable,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { render } from "@opentui/solid"
import { createSignal, createMemo } from "solid-js"
import { basename, resolve } from "node:path"

import { Divider } from "./divider.ts"
import { SpaceSet, type Space } from "./space.ts"
import { frame, type Window } from "./window.ts"
import type { Agent } from "./agent.ts"
import { readGit } from "./git.ts"
import { encodeKey } from "./keys.ts"
import {
  createBindings,
  helpGroups,
  nextKeys,
  formatSequence,
  leaderBytes,
  DEFAULT_LEADER,
  type CommandSpec,
  type Conflict,
  type Keys,
} from "./bindings.ts"
import { loadConfig, saveConfig, applyConfig, type Config } from "./config.ts"
import { createAppState } from "./ui/state.ts"
import { sidebarTargets } from "./ui/Sidebar.tsx"
import { App, type Overlay } from "./ui/App.tsx"
import {
  SETTINGS_SECTIONS,
  settingsFields,
  keybindTargets,
  keybindLine,
  type SettingsSection,
} from "./ui/Settings.tsx"
import type { PromptRequest } from "./ui/Prompt.tsx"

const config = await loadConfig()
// Push the loaded values into the copy imperative code reads.
applyConfig(config)
const SHELL = [config.behaviour.shell || process.env.SHELL || "bash"]

const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 60, useMouse: true })

// Raw key passthrough needs the OUTER terminal to keep emitting classic escape
// sequences — the children speak xterm-256color terminfo and would misparse the
// CSI-u forms a kitty-enabled host produces.
renderer.useKittyKeyboard = false

// The imperative half: split trees of cell-blitting panes. Solid adopts this
// box as a child but never reconciles inside it.
const paneHost = new BoxRenderable(renderer, {
  id: "pane-host",
  flexDirection: "row",
  flexGrow: 1,
})

const spaces = new SpaceSet(renderer, paneHost, SHELL)
const app = createAppState(spaces)

/**
 * What to do after an agent's process exits and its views have closed.
 *
 * Only exits trigger this. Closing a view with ^a x is a deliberate detach —
 * the agent keeps running and the user wants it out of the way — so reopening
 * it there would fight the user. An exit is different: the pane went away
 * because the process ended, which can leave nothing on screen and nowhere for
 * keystrokes to go.
 *
 * The cascade is tmux's: the window closes when its last pane dies, the space
 * when its last window closes, and the app with the last space. The one
 * exception is that a still-running agent is never discarded silently — if the
 * window has one detached, it is shown instead of being killed with the window.
 */
function afterAgentExit(_agent: Agent, window: Window, space: Space) {
  if (window.panes.length > 0) return

  const live = window.agents.find((a) => a.state !== "done")
  if (live) {
    window.reveal(live)
    return
  }

  space.closeWindow(window)
  if (space.windows.length > 0) return

  spaces.remove(space)
  // Nothing running and no space left: an empty screen would just be a dead
  // end, so exiting is the honest outcome.
  if (spaces.spaces.length === 0) shutdown()
}
spaces.onAgentExit = afterAgentExit

const [configState, setConfigState] = createSignal<Config>(config)

/** Sidebar width lives in the config so the drag and the settings window are
 *  editing the same number, and dragging it survives a save. */
const SIDEBAR_MIN = 16
const SIDEBAR_MAX = 60
function resizeSidebar(delta: number) {
  setConfigState((c) => ({
    ...c,
    sidebar: {
      ...c.sidebar,
      width: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, c.sidebar.width + delta)),
    },
  }))
  setSettingsDirty(true)
}

// A Divider rather than a component with mouse props: dragging a one-cell
// target only works if the pointer is claimed on the press, and that is a
// renderable-level concern. See the note in divider.ts.
const sidebarHandle = new Divider(renderer, {
  id: "sidebar-divider",
  axis: "row",
  onDrag: resizeSidebar,
})
// It is the pane frame's left border, not a bare rule between two regions: it
// finishes with corners and the panes beside it stop drawing a left edge, so
// the seam is one column wide instead of two adjacent lines.
sidebarHandle.tees = true
sidebarHandle.outer = true
sidebarHandle.capStart = true
sidebarHandle.capEnd = true

const [sidebarOpen, setSidebarOpen] = createSignal(config.sidebar.open)
const [sidebarFocused, setSidebarFocused] = createSignal(false)
const [selected, setSelected] = createSignal(0)
const [hovered, setHovered] = createSignal<number | null>(null)
const [overlay, setOverlay] = createSignal<Overlay>("none")
// The raw compiled parts, not a formatted string: the which-key panel has to
// match them against every binding's sequence to work out what is still
// reachable, and a display string cannot be matched back.
const [pendingParts, setPendingParts] = createSignal<readonly { display: string }[]>([])
const [promptRequest, setPromptRequest] = createSignal<PromptRequest | null>(null)
const [settingsSection, setSettingsSection] = createSignal<SettingsSection>("sidebar")
const [settingsSelected, setSettingsSelected] = createSignal(0)
const [settingsDirty, setSettingsDirty] = createSignal(false)
/** True while the keybind editor is waiting for the keystroke to record. */
const [capturing, setCapturing] = createSignal(false)
const [conflicts, setConflicts] = createSignal<Conflict[]>([])
/** The keybind tab's scroll container, so ↑↓ can drive a list that is much
 *  longer than the window. */
let keybindList: ScrollBoxRenderable | null = null
const [size, setSize] = createSignal({ width: renderer.width, height: renderer.height })
renderer.on("resize", (width: number, height: number) => setSize({ width, height }))

const targets = createMemo(() => sidebarTargets(app.spaces()))
const activeWin = () => spaces.activeWindow

/** Open a modal prompt and resolve with the field values, or null on cancel. */
function ask(title: string, fields: PromptRequest["fields"]): Promise<string[] | null> {
  return new Promise((resolveAsk) => {
    setPromptRequest({
      title,
      fields,
      resolve: (values) => {
        setPromptRequest(null)
        resolveAsk(values)
      },
    })
  })
}

async function newSpace() {
  const cwd = spaces.active?.dir ?? process.cwd()
  const answers = await ask("New space", [
    { label: "Name", value: basename(cwd), placeholder: "space name" },
    { label: "Directory", value: cwd, placeholder: "path" },
  ])
  if (!answers) return
  const [name, dir] = answers
  // An empty field means "keep the default" rather than "make it blank".
  const target = resolve(dir?.trim() || cwd)
  const space = spaces.create(name?.trim() || basename(target), target)
  spaces.activate(space)
  space.newWindow().init()
  void refreshGit()
}

async function renameSpace() {
  const space = spaces.active
  if (!space) return
  const answers = await ask("Rename space", [{ label: "Name", value: space.name }])
  const name = answers?.[0]?.trim()
  if (!name) return
  space.name = name
  app.refresh()
}

async function renameWindow() {
  const window = spaces.activeWindow
  if (!window) return
  const answers = await ask("Rename window", [
    { label: "Name", value: window.customName ?? "", placeholder: window.title },
  ])
  if (!answers) return
  // Clearing the field hands the name back to whatever the window is running.
  window.customName = answers[0]?.trim() || null
  app.refresh()
}

function moveSelection(delta: number) {
  const count = targets().length
  if (!count) return
  setSelected((s) => Math.max(0, Math.min(count - 1, s + delta)))
}

/** Act on the sidebar selection: a space row switches space, an agent row
 *  focuses or opens a view of it. */
function activateSelection(index = selected()) {
  const target = targets()[index]
  if (!target) return
  setSelected(index)
  if (target.space !== spaces.active) spaces.activate(target.space)
  if (target.kind !== "space") target.space.selectWindow(target.window)
  if (target.kind === "agent") target.window.reveal(target.agent)
  setSidebarFocused(false)
  app.refresh()
}

function killSelection() {
  const target = targets()[selected()]
  if (!target) return
  // Kill what the row actually represents, so x means the same thing at every
  // level of the tree.
  if (target.kind === "agent") target.window.killAgent(target.agent)
  else if (target.kind === "window") target.space.closeWindow(target.window)
  else spaces.remove(target.space)
  app.refresh()
}

/**
 * Keep the pane frame in step with the sidebar.
 *
 * While the sidebar is open its handle is the frame's left border, so every
 * pane must stop drawing one; closing it hands that side back. And because the
 * handle *is* the leftmost pane's border, it highlights with that pane rather
 * than sitting inertly grey next to a focused one.
 */
function syncSidebarBorder() {
  sidebarHandle.adjacentToFocus = sidebarOpen() && (spaces.activeWindow?.focusAtLeftEdge ?? false)
}

function syncSidebarFrame() {
  frame.externalLeft = sidebarOpen()
  syncSidebarBorder()
  spaces.refreshChrome()
}

// Appended to the app state's own handler rather than replacing it: focus moves
// are structural changes, and this is the only notification of one.
const notifyChange = spaces.onChange
spaces.onChange = () => {
  notifyChange?.()
  syncSidebarBorder()
}

function toggleSidebar() {
  // closed -> open+focused, open+focused -> closed, open+unfocused -> focus it.
  if (!sidebarOpen()) {
    setSidebarOpen(true)
    setSidebarFocused(true)
    selectFocusedAgent()
  } else if (sidebarFocused()) {
    setSidebarOpen(false)
    setSidebarFocused(false)
  } else {
    setSidebarFocused(true)
    selectFocusedAgent()
  }
  syncSidebarFrame()
}

function selectFocusedAgent() {
  const agent = spaces.activeWindow?.focused?.agent
  if (!agent) return
  const i = targets().findIndex((t) => t.kind === "agent" && t.agent === agent)
  if (i !== -1) setSelected(i)
}

function editSetting(delta: number) {
  const next = structuredClone(configState())
  const section = settingsSection()
  const field = settingsSelected()
  if (section === "sidebar") {
    if (field === 0) {
      next.sidebar.width = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, next.sidebar.width + delta))
    }
    else next.sidebar.open = !next.sidebar.open
  } else if (section === "behaviour") {
    if (field === 0) {
      next.behaviour.scrollRows = Math.max(1, Math.min(20, next.behaviour.scrollRows + delta))
    }
  }
  setConfigState(next)
  applyConfig(next)
  setSettingsDirty(true)
}

/**
 * Put a new set of keys into effect.
 *
 * One path for every change — the prefix, a rebind, a reset — because the
 * keymap has to be rebuilt for any of them and the conflict report is only
 * true for the set that was actually applied.
 */
function setKeys(next: Keys) {
  setConfigState((c) => ({ ...c, keys: next }))
  setConflicts(bindings.apply(next))
  setSettingsDirty(true)
}

/** The command a keybind row edits, or null for the prefix row. */
function keybindTarget(index = settingsSelected()): string | null | undefined {
  return keybindTargets(groups())[index]
}

/** Record the next keystroke as the selected row's binding. */
function captureBinding() {
  const targets = keybindTargets(groups())
  const index = settingsSelected()
  if (index >= targets.length) return
  const command = targets[index]!
  setCapturing(true)
  bindings.capture((event, key) => {
    setCapturing(false)
    // Escape backs out — a binding on escape would swallow the one key every
    // overlay in the app relies on.
    if (event.name === "escape") return
    const keys = configState().keys
    if (command === null) setKeys({ ...keys, leader: key })
    // Recorded under the prefix, which is what every binding in the app is:
    // an unprefixed one would eat that key from every shell running in a pane.
    else setKeys({ ...keys, bindings: { ...keys.bindings, [command]: [`<leader>${key}`] } })
  })
}

/** Back to what the command shipped with, or to nothing at all. */
function resetBinding(unbind: boolean) {
  const command = keybindTarget()
  const keys = configState().keys
  if (command === undefined) return
  if (command === null) {
    if (unbind) return // The app is unreachable without a prefix.
    return setKeys({ ...keys, leader: DEFAULT_LEADER })
  }
  const next = { ...keys.bindings }
  if (unbind) next[command] = []
  else delete next[command]
  setKeys({ ...keys, bindings: next })
}

const COMMANDS: CommandSpec[] = [
  // Panes — splits keep the tmux-ish | and -, which read better than " and %.
  {
    name: "pane.split-row",
    key: ["<leader>|", "<leader>\\"],
    desc: "split left/right",
    group: "panes",
    run: () => void activeWin()?.split("row"),
  },
  {
    name: "pane.split-column",
    key: "<leader>-",
    desc: "split top/bottom",
    group: "panes",
    run: () => void activeWin()?.split("column"),
  },
  {
    name: "pane.next",
    key: "<leader>o",
    desc: "next pane",
    group: "panes",
    run: () => activeWin()?.focusNext(1),
  },
  // Directional focus, tmux's select-pane. Two sequences per direction rather
  // than two commands, so the help shows both against one entry.
  ...(
    [
      ["left", "h"],
      ["down", "j"],
      ["up", "k"],
      ["right", "l"],
    ] as const
  ).map(([direction, letter]) => ({
    name: `pane.focus-${direction}`,
    key: [`<leader>${letter}`, `<leader>${direction}`],
    desc: `focus pane ${direction}`,
    group: "panes",
    run: () => activeWin()?.focusDirection(direction),
  })),
  {
    name: "pane.zoom",
    key: "<leader>z",
    desc: "zoom the focused pane (Z in the tab)",
    group: "panes",
    run: () => activeWin()?.zoom(),
  },
  {
    name: "pane.swap-previous",
    key: "<leader>{",
    desc: "swap pane with the previous one",
    group: "panes",
    run: () => activeWin()?.swap(-1),
  },
  {
    name: "pane.swap-next",
    key: "<leader>}",
    desc: "swap pane with the next one",
    group: "panes",
    run: () => activeWin()?.swap(1),
  },
  {
    name: "pane.close",
    key: "<leader>x",
    desc: "close pane (agent keeps running)",
    group: "panes",
    run: () => {
      const w = activeWin()
      if (w?.focused) w.close(w.focused)
    },
  },

  // Windows.
  {
    name: "window.new",
    key: "<leader>c",
    desc: "new window",
    group: "windows",
    run: () => void spaces.active?.newWindow().init(),
  },
  {
    name: "window.next",
    key: "<leader>n",
    desc: "next window",
    group: "windows",
    run: () => spaces.active?.cycleWindow(1),
  },
  {
    name: "window.previous",
    key: "<leader>p",
    desc: "previous window",
    group: "windows",
    run: () => spaces.active?.cycleWindow(-1),
  },
  {
    name: "window.rename",
    key: "<leader>,",
    desc: "rename window",
    group: "windows",
    run: () => void renameWindow(),
  },
  {
    name: "window.close",
    key: "<leader>&",
    desc: "kill window and its agents",
    group: "windows",
    run: () => {
      const space = spaces.active
      const w = space?.active
      if (space && w) space.closeWindow(w)
    },
  },
  // 1..9 select by the window's own number, which is why that number is stable
  // rather than a position in the list.
  ...Array.from({ length: 9 }, (_, i) => ({
    name: `window.select-${i + 1}`,
    key: `<leader>${i + 1}`,
    desc: i === 0 ? "select window 1..9" : `select window ${i + 1}`,
    // Listed once, on the first; see CommandSpec.hidden for why this is a flag
    // and not an empty description.
    hidden: i > 0,
    group: "windows",
    run: () => void spaces.active?.selectNumber(i + 1),
  })),

  // Agents.
  {
    name: "agent.kill",
    // shift+k: plain ^a k is directional pane focus, and killing an agent is
    // not something to put one keystroke away from "move up" anyway.
    key: "<leader>shift+k",
    desc: "stop the focused agent",
    group: "agents",
    run: () => {
      const w = activeWin()
      if (w?.focused) w.killAgent(w.focused.agent)
    },
  },
  {
    name: "agent.next-blocked",
    key: "<leader>a",
    desc: "jump to the next blocked agent",
    group: "agents",
    run: () => {
      const agent = spaces.nextBlocked()
      if (!agent) return
      const index = targets().findIndex((target) => target.kind === "agent" && target.agent === agent)
      if (index !== -1) setSelected(index)
    },
  },

  // Spaces.
  {
    name: "space.new",
    key: "<leader>s",
    desc: "new space",
    group: "spaces",
    run: () => void newSpace(),
  },
  {
    name: "space.rename",
    key: "<leader>r",
    desc: "rename space",
    group: "spaces",
    run: () => void renameSpace(),
  },
  {
    name: "space.next",
    key: "<leader>)",
    desc: "next space",
    group: "spaces",
    run: () => spaces.cycle(1),
  },
  {
    name: "space.previous",
    key: "<leader>(",
    desc: "previous space",
    group: "spaces",
    run: () => spaces.cycle(-1),
  },

  // App.
  {
    name: "sidebar.toggle",
    key: "<leader>b",
    desc: "toggle sidebar",
    group: "global",
    run: toggleSidebar,
  },
  {
    name: "app.help",
    key: ["<leader>?", "<leader>/"],
    desc: "keybinds",
    group: "global",
    // The same window as settings, on its keybinds tab. Two overlays rendering
    // the same list from the same data was one overlay too many to teach.
    run: () => {
      if (overlay() === "settings" && settingsSection() === "keybinds") return setOverlay("none")
      setSettingsSection("keybinds")
      setSettingsSelected(0)
      setOverlay("settings")
    },
  },
  {
    name: "app.settings",
    // shift+s, not "S": a bare capital compiles to the same sequence as the
    // lowercase one, so this was silently shadowed by space.new's ^a s.
    key: "<leader>shift+s",
    desc: "settings",
    group: "global",
    run: () => {
      if (overlay() === "settings") return setOverlay("none")
      // Opening settings should land on settings, not on wherever ^a ? left the
      // tab last time.
      if (settingsSection() === "keybinds") setSettingsSection("sidebar")
      setSettingsSelected(0)
      setOverlay("settings")
    },
  },
  {
    name: "app.send-prefix",
    // The prefix twice, written as the token so it follows a rebind — and sent
    // as whatever bytes that prefix actually produces.
    key: "<leader><leader>",
    desc: "send a literal prefix key",
    group: "global",
    // Not offered in the editor: its sequence is the prefix, and the prefix
    // row already edits that.
    fixed: true,
    run: () => {
      const bytes = leaderBytes(bindings.leader())
      if (bytes) activeWin()?.focused?.write(bytes)
    },
  },
  { name: "app.quit", key: "<leader>q", desc: "quit", group: "global", run: () => shutdown() },
]

/**
 * Keys not claimed by a binding belong to the child — except while a modal or
 * the sidebar has focus. Returns whether the app consumed the key; see the
 * note on preventDefault in bindings.ts.
 */
function onUnhandled(event: KeyEvent): boolean {
  if (promptRequest()) {
    // Escape cancels; everything else belongs to the focused input, so leave
    // the event alone and let focus routing deliver it.
    if (event.name === "escape") {
      promptRequest()?.resolve(null)
      return true
    }
    return false
  }
  if (overlay() !== "none") {
    if (event.name === "escape" || event.name === "q") setOverlay("none")
    else if (overlay() === "settings") settingsKey(event)
    return true
  }
  if (sidebarFocused()) {
    sidebarKey(event)
    return true
  }
  const bytes = encodeKey(event)
  if (bytes !== null) activeWin()?.focused?.write(bytes)
  return true
}

function sidebarKey(event: KeyEvent) {
  switch (event.name) {
    case "j":
    case "down":
      return moveSelection(1)
    case "k":
    case "up":
      return moveSelection(-1)
    case "g":
    case "home":
      return setSelected(0)
    case "G":
    case "end":
      return setSelected(Math.max(0, targets().length - 1))
    case "return":
    case "enter":
      return activateSelection()
    case "x":
      return killSelection()
    case "escape":
      return setSidebarFocused(false)
  }
}

function cycleSettingsSection(step: 1 | -1) {
  const i = SETTINGS_SECTIONS.indexOf(settingsSection())
  setSettingsSection(
    SETTINGS_SECTIONS[(i + step + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length]!,
  )
  setSettingsSelected(0)
}

/** Move the keybind selection and keep it on screen. */
function moveKeybind(delta: number) {
  const count = keybindTargets(groups()).length
  const index = Math.max(0, Math.min(count - 1, settingsSelected() + delta))
  setSettingsSelected(index)
  const box = keybindList
  if (!box) return
  // The list is several screens long, so follow the selection rather than
  // leaving it to be moved off the top of a window it cannot scroll itself.
  const line = keybindLine(groups(), index)
  const height = box.viewport?.height ?? box.height
  if (line < box.scrollTop) box.scrollTop = line
  else if (line >= box.scrollTop + height) box.scrollTop = line - height + 1
}

function keybindsKey(event: KeyEvent) {
  switch (event.name) {
    case "tab":
      return cycleSettingsSection(event.shift ? -1 : 1)
    case "j":
    case "down":
      return moveKeybind(1)
    case "k":
    case "up":
      return moveKeybind(-1)
    case "pagedown":
      return moveKeybind(10)
    case "pageup":
      return moveKeybind(-10)
    case "return":
    case "enter":
      return captureBinding()
    case "u":
      return resetBinding(false)
    case "d":
      return resetBinding(true)
    case "s":
      void saveConfig(configState()).then(() => setSettingsDirty(false))
      return
  }
}

function settingsKey(event: KeyEvent) {
  const fields = settingsFields(configState(), settingsSection())
  // The keybind tab edits sequences rather than values, so it has its own keys.
  if (settingsSection() === "keybinds") return keybindsKey(event)
  switch (event.name) {
    case "tab":
      return cycleSettingsSection(event.shift ? -1 : 1)
    case "j":
    case "down":
      return setSettingsSelected((s) => Math.min(Math.max(0, fields.length - 1), s + 1))
    case "k":
    case "up":
      return setSettingsSelected((s) => Math.max(0, s - 1))
    case "left":
      return editSetting(-1)
    case "right":
      return editSetting(1)
    case "s":
      void saveConfig(configState()).then(() => setSettingsDirty(false))
      return
  }
}

const bindings = createBindings(renderer, COMMANDS, { keys: config.keys, onUnhandled })
setConflicts(bindings.conflicts())

// Only source of truth for the hint line and the which-key panel: what the
// keymap will actually do next, so a rebinding shows up in both without
// touching this file.
bindings.keymap.on("pendingSequence", (sequence) => setPendingParts(sequence))

const pending = createMemo(() =>
  pendingParts().length ? [formatSequence(pendingParts(), configState().keys.leader)] : [],
)
const hints = createMemo(() => nextKeys(bindings, COMMANDS, pendingParts()))

// Recomputed whenever the keys change, since that is what the list is *for*:
// the reference and the editor are the same rows, read back out of the keymap
// that was just rebuilt.
const groups = createMemo(() => helpGroups(bindings, COMMANDS, configState().keys))

/** How one command's binding reads, for chrome that names a key. Empty when it
 *  has none — the sidebar hint says so rather than naming a dead key. */
function commandKeys(name: string): string {
  for (const group of groups()) {
    const entry = group.entries.find((e) => e.name === name)
    if (entry) return entry.keys === "unbound" ? "" : entry.keys
  }
  return ""
}

/** Refresh every space's branch/ahead-behind. Polled because git state changes
 *  behind our back with nothing to notify us. */
async function refreshGit() {
  for (const space of spaces.spaces) {
    const info = await readGit(space.dir)
    if (info.branch === space.branch && info.ahead === space.ahead && info.behind === space.behind)
      continue
    space.branch = info.branch
    space.ahead = info.ahead
    space.behind = info.behind
    app.refresh()
  }
}

function shutdown() {
  spaces.disposeAll()
  app.dispose()
  renderer.destroy()
  process.exit(0)
}
const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 }
for (const sig of Object.keys(SIGNAL_EXIT)) {
  process.once(sig, () => {
    spaces.disposeAll()
    process.exit(SIGNAL_EXIT[sig])
  })
}
process.once("exit", () => spaces.disposeAll())

// Before the first window exists, so its panes are built with the right edges.
syncSidebarFrame()
const first = spaces.create(basename(process.cwd()) || "space", process.cwd())
first.newWindow().init()
syncSidebarFrame()
void refreshGit()
const gitTimer = setInterval(() => void refreshGit(), 5000)
gitTimer.unref?.()

await render(
  () => (
    <App
      app={app}
      config={configState()}
      paneHost={paneHost}
      size={size()}
      sidebarHandle={sidebarHandle}
      sidebarWidth={configState().sidebar.width}
      sidebarOpen={sidebarOpen()}
      sidebarFocused={sidebarFocused()}
      sidebarToggleKeys={commandKeys("sidebar.toggle")}
      selected={selected()}
      hovered={hovered()}
      onHover={setHovered}
      onActivate={activateSelection}
      pending={pending()}
      hints={hints()}
      onSelectWindow={(w) => {
        spaces.active?.selectWindow(w)
        app.refresh()
      }}
      overlay={overlay()}
      helpGroups={groups()}
      // From the config rather than the keymap: a plain method call would not
      // re-render the list when the prefix changes.
      leader={configState().keys.leader}
      conflicts={conflicts()}
      capturing={capturing()}
      settingsSection={settingsSection()}
      settingsSelected={settingsSelected()}
      settingsDirty={settingsDirty()}
      onKeybindList={(box) => {
        keybindList = box
      }}
      prompt={promptRequest()}
    />
  ),
  renderer,
)
