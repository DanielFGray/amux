/** @jsxImportSource @opentui/solid */
import { createCliRenderer, BoxRenderable, type KeyEvent } from "@opentui/core"
import { render } from "@opentui/solid"
import { createSignal, createMemo } from "solid-js"
import { basename, resolve } from "node:path"

import { SpaceSet, type Space } from "./space.ts"
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
 * What to show after an agent's process exits and its views have closed.
 *
 * Only exits trigger this. Closing a view with ^a x is a deliberate detach —
 * the agent keeps running and the user wants it out of the way — so reopening
 * it there would fight the user. An exit is different: the pane went away
 * because the process ended, which can leave the space with nothing on screen
 * and nowhere for keystrokes to go.
 *
 * tmux closes the window when its last pane dies, and the session with the last
 * window. Same here, with one exception: an agent still running is never
 * discarded silently, so if any survive we show one instead.
 */
function afterAgentExit(_agent: Agent, space: Space) {
  if (space !== spaces.active || space.workspace.panes.length > 0) return
  const live = space.agents.find((a) => a.state !== "done")
  if (live) {
    space.workspace.reveal(live)
    return
  }
  spaces.remove(space)
  // Nothing running and no space left: an empty screen would just be a dead
  // end, so exiting is the honest outcome.
  if (spaces.spaces.length === 0) shutdown()
}
spaces.onAgentExit = afterAgentExit

const [configState, setConfigState] = createSignal<Config>(config)
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
const activeWs = () => spaces.active?.workspace ?? null

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
  space.workspace.init("shell")
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
  if (target.kind === "agent") target.space.workspace.reveal(target.agent)
  setSidebarFocused(false)
  app.refresh()
}

function killSelection() {
  const target = targets()[selected()]
  if (target?.kind !== "agent") return
  target.space.workspace.killAgent(target.agent)
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
  const agent = spaces.active?.workspace.focused?.agent
  if (!agent) return
  const i = targets().findIndex((t) => t.kind === "agent" && t.agent === agent)
  if (i !== -1) setSelected(i)
}

function editSetting(delta: number) {
  const next = structuredClone(configState())
  const section = settingsSection()
  const field = settingsSelected()
  if (section === "sidebar") {
    if (field === 0) next.sidebar.width = Math.max(16, Math.min(60, next.sidebar.width + delta))
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
  {
    name: "pane.split-row",
    key: ["<leader>|", "<leader>\\"],
    desc: "split left/right",
    group: "panes",
    run: () => void activeWs()?.split("row"),
  },
  {
    name: "pane.split-column",
    key: "<leader>-",
    desc: "split top/bottom",
    group: "panes",
    run: () => void activeWs()?.split("column"),
  },
  {
    name: "pane.next",
    key: "<leader>n",
    desc: "focus next pane",
    group: "panes",
    run: () => activeWs()?.focusNext(1),
  },
  {
    name: "pane.previous",
    key: "<leader>p",
    desc: "focus previous pane",
    group: "panes",
    run: () => activeWs()?.focusNext(-1),
  },
  {
    name: "pane.close",
    key: "<leader>x",
    desc: "close view (agent keeps running)",
    group: "panes",
    run: () => {
      const ws = activeWs()
      if (ws?.focused) ws.close(ws.focused)
    },
  },
  {
    name: "agent.kill",
    key: "<leader>k",
    desc: "stop the focused agent",
    group: "agents",
    run: () => {
      const ws = activeWs()
      if (ws?.focused) ws.killAgent(ws.focused.agent)
    },
  },
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
    key: "<leader>]",
    desc: "next space",
    group: "spaces",
    run: () => spaces.cycle(1),
  },
  {
    name: "space.previous",
    key: "<leader>[",
    desc: "previous space",
    group: "spaces",
    run: () => spaces.cycle(-1),
  },
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
    key: "<leader>,",
    desc: "settings",
    group: "global",
    run: () => setOverlay((o) => (o === "settings" ? "none" : "settings")),
  },
  {
    name: "app.send-prefix",
    key: "<leader>ctrl+a",
    desc: "send a literal ctrl+a",
    group: "global",
    run: () => activeWs()?.focused?.write("\x01"),
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
  if (bytes !== null) activeWs()?.focused?.write(bytes)
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
first.workspace.init("shell")
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
      sidebarOpen={sidebarOpen()}
      sidebarFocused={sidebarFocused()}
      selected={selected()}
      hovered={hovered()}
      onHover={setHovered}
      onActivate={activateSelection}
      pending={pending()}
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
