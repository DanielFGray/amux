/** @jsxImportSource @opentui/solid */
import { createCliRenderer, BoxRenderable, type KeyEvent } from "@opentui/core"
import { render } from "@opentui/solid"
import { createSignal, createMemo } from "solid-js"
import { basename, resolve } from "node:path"

import { Divider } from "./divider.ts"
import { SpaceSet, type Space } from "./space.ts"
import type { Window } from "./window.ts"
import type { Agent } from "./agent.ts"
import { readGit } from "./git.ts"
import { encodeKey } from "./keys.ts"
import { createBindings, helpGroups, formatSequence, type CommandSpec } from "./bindings.ts"
import { loadConfig, saveConfig, applyConfig, type Config } from "./config.ts"
import { createAppState } from "./ui/state.ts"
import { sidebarTargets } from "./ui/Sidebar.tsx"
import { App, type Overlay } from "./ui/App.tsx"
import { SETTINGS_SECTIONS, settingsFields, type SettingsSection } from "./ui/Settings.tsx"
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
const [sidebarOpen, setSidebarOpen] = createSignal(config.sidebar.open)
const [sidebarFocused, setSidebarFocused] = createSignal(false)
const [selected, setSelected] = createSignal(0)
const [hovered, setHovered] = createSignal<number | null>(null)
const [overlay, setOverlay] = createSignal<Overlay>("none")
const [pending, setPending] = createSignal<string[]>([])
const [promptRequest, setPromptRequest] = createSignal<PromptRequest | null>(null)
const [settingsSection, setSettingsSection] = createSignal<SettingsSection>("sidebar")
const [settingsSelected, setSettingsSelected] = createSignal(0)
const [settingsDirty, setSettingsDirty] = createSignal(false)
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
  space.newWindow().init("shell")
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
    run: () => void spaces.active?.newWindow().init("shell"),
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
    desc: i === 0 ? "select window 1..9" : "",
    group: "windows",
    run: () => void spaces.active?.selectNumber(i + 1),
  })),

  // Agents.
  {
    name: "agent.kill",
    key: "<leader>k",
    desc: "stop the focused agent",
    group: "agents",
    run: () => {
      const w = activeWin()
      if (w?.focused) w.killAgent(w.focused.agent)
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
    run: () => setOverlay((o) => (o === "help" ? "none" : "help")),
  },
  {
    name: "app.settings",
    key: "<leader>S",
    desc: "settings",
    group: "global",
    run: () => setOverlay((o) => (o === "settings" ? "none" : "settings")),
  },
  {
    name: "app.send-prefix",
    key: "<leader>ctrl+a",
    desc: "send a literal ctrl+a",
    group: "global",
    run: () => activeWin()?.focused?.write("\x01"),
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

function settingsKey(event: KeyEvent) {
  const fields = settingsFields(configState(), settingsSection())
  switch (event.name) {
    case "tab": {
      const step = event.shift ? -1 : 1
      const i = SETTINGS_SECTIONS.indexOf(settingsSection())
      setSettingsSection(
        SETTINGS_SECTIONS[(i + step + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length]!,
      )
      setSettingsSelected(0)
      return
    }
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

const keymap = createBindings(renderer, COMMANDS, { onUnhandled })

// Only source of truth for the hint line: what the keymap will actually do
// next, so a rebinding shows up here without touching this file.
keymap.on("pendingSequence", (sequence) => {
  setPending(sequence.length ? [formatSequence(sequence)] : [])
})

const groups = helpGroups(keymap, COMMANDS)

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

const first = spaces.create(basename(process.cwd()) || "space", process.cwd())
first.newWindow().init("shell")
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
      selected={selected()}
      hovered={hovered()}
      onHover={setHovered}
      onActivate={activateSelection}
      pending={pending()}
      onSelectWindow={(w) => {
        spaces.active?.selectWindow(w)
        app.refresh()
      }}
      overlay={overlay()}
      helpGroups={groups}
      settingsSection={settingsSection()}
      settingsSelected={settingsSelected()}
      settingsDirty={settingsDirty()}
      prompt={promptRequest()}
    />
  ),
  renderer,
)
