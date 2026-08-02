/** @jsxImportSource @opentui/solid */
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { createSignal, createMemo } from "solid-js"
import { Effect } from "effect"
import { basename, join, resolve } from "node:path"
import { writeFileSync } from "node:fs"

import { Divider } from "./divider.ts"
import { SpaceSet, type Space } from "./space.ts"
import { frame, type Window } from "./window.ts"
import { nextPreset, LAYOUT_PRESETS, type LayoutPreset } from "./layout.ts"
import type { Agent } from "./agent.ts"
import type { TerminalPane } from "./pane.ts"
import { readGit } from "./git.ts"
import { encodeKey } from "./keys.ts"
import { pickSendTarget, sendKeys, type SendTarget } from "./send.ts"
import {
  createBindings,
  helpGroups,
  nextKeys,
  formatSequence,
  leaderBytes,
  parseKeyStrokes,
  DEFAULT_LEADER,
  type CommandSpec,
  type Conflict,
  type Keys,
  filterPaletteEntries,
  paletteEntries,
} from "./bindings.ts"
import { saveConfig, applyConfig, type Config } from "./config.ts"
import type { SessionClientShape } from "./client.ts"
import { restoreSession, snapshotSpace } from "./snapshot.ts"
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
import {
  captureSpan,
  pickCaptureTarget,
  type CaptureSpan,
  type CaptureTarget,
} from "./capture.ts"
import { Capture, type CaptureView } from "./ui/Capture.tsx"
import { CopyMode } from "./copy.ts"
import { workspaceEnv } from "./env.ts"

export interface AppOptions {
  readonly renderer: CliRenderer
  /** The imperative half of the tree, created by the caller because the
   *  renderer owns it and the Effect program owns the renderer. */
  readonly paneHost: BoxRenderable
  readonly config: Config
  readonly session: SessionClientShape
  /** Ask the program to exit. The app does not own the process, the renderer or
   *  the session, so leaving is a request rather than a teardown. */
  readonly quit: () => void
}

export interface AppHandle {
  /** The Solid component the caller renders. A function, not a props object:
   *  the signals below are read inside it, and evaluating them any earlier
   *  would hand `render` a dead snapshot. */
  readonly View: () => JSX.Element
  /** Write the workspace out. Called on the way down by the session's
   *  finalizer, which is what makes a signal save the session. */
  readonly persist: () => Promise<void>
  readonly dispose: () => void
}

/**
 * Everything above the renderer: the workspace, the key bindings, the overlays
 * and the commands that drive them.
 *
 * This function owns no process-level resource. The renderer, the session and
 * the process itself belong to the Effect program in main.tsx, which acquires
 * them in order and releases them in reverse. That is the whole reason `quit`
 * is a callback: exiting is a request, and the teardown that follows is the
 * caller's, in one place, on every path including a signal.
 */
export function createApp({ renderer, paneHost, config, session, quit }: AppOptions): AppHandle {
  const SHELL = [config.behaviour.shell || process.env.SHELL || "bash"]
  const SESSION_ID = session.id

  const spaces = new SpaceSet(workspaceEnv(renderer, { shell: SHELL, backend: session.backend() }), paneHost)
  spaces.onCopy = (text) => renderer.copyToClipboardOSC52(text)
  spaces.onCopyError = (error) => console.error(error.message)
  const app = createAppState(spaces)

  /**
   * Keyboard copy mode: the pane's read-only review layer. One instance for the
   * whole app, entered on whatever pane is focused. The mode renders through the
   * pane's existing selection machinery and copies through the same chain the
   * mouse drag does, so nothing here owns a second copy path.
   */
  const copyMode = new CopyMode()
  copyMode.onStateChange = () => app.refresh()
  // The search prompt reuses the app's modal prompt; resolve feeds the query back
  // into the mode. A blank query or a cancel leaves the search untouched.
  copyMode.onSearchRequest = (dir) => {
    setPromptError("")
    setPromptRequest({
      title: dir === "forward" ? "search forward" : "search backward",
      footer: "smartcase: case-insensitive unless the pattern has a capital",
      fields: [{ label: "pattern", placeholder: "text to find" }],
      resolve: (values) => {
        const query = values?.[0] ?? ""
        setPromptRequest(null)
        if (query) copyMode.search(query, dir)
      },
    })
  }
  // Output that lands while the mode rides the live bottom re-pins the cursor to
  // the newest row, so the highlight follows the screen instead of stranding in
  // history. A no-op whenever the mode is parked or inactive — and never allowed
  // to touch a pane that has left the tree: a tick landing between a structural
  // change and its notification must not invalidate a view being torn down.
  const copyTimer = setInterval(() => {
    const pane = copyMode.pane
    if (pane && !paneStillMounted(pane)) return
    copyMode.reconcile()
  }, 100)
  copyTimer.unref?.()

  /**
   * Session persistence.
   *
   * The workspace is written out as metadata — spaces, windows, their split
   * arrangements and what each agent was started with — and read back at the next
   * launch. Terminal contents are NOT in it and cannot be; see snapshot.ts for
   * what that does and does not restore.
   *
   * The daemon writes the file, not us: it is already writing attachment state
   * into the same file, and two writers would race over it. We send what we see.
   *
   * Writes are debounced because onChange fires on every keystroke that changes a
   * title, and coalesced through a chain so two saves can never interleave. The
   * chaining onto whatever onChange was already there is the same idiom
   * createAppState uses: this is one more observer, not the owner.
   */
  const SAVE_DEBOUNCE_MS = 500

  let saveTimer: Timer | null = null
  let saving: Promise<void> = Promise.resolve()

  function persistSession(): Promise<void> {
    const workspace = {
      spaces: spaces.spaces.map(snapshotSpace),
      activeSpace: spaces.active?.id ?? null,
    }
    saving = saving.then(() => Effect.runPromise(session.save(workspace))).catch((error) => {
      // A session that cannot be written is worth saying once, not worth taking
      // the app down for: everything still running keeps running.
      console.error(`could not save session '${SESSION_ID}': ${String(error)}`)
    })
    return saving
  }

  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persistSession()
    }, SAVE_DEBOUNCE_MS)
    saveTimer.unref?.()
  }

  const previousOnChange = spaces.onChange
  spaces.onChange = () => {
    previousOnChange?.()
    scheduleSave()
  }

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

    // Closing the window — and possibly the whole space — frees the agents'
    // terminals, so any copy mode sitting on a pane in this space must end
    // first: the mode's own exit clears the selection through that terminal.
    exitCopyModeFor(space.windows.flatMap((w) => w.panes))
    space.closeWindow(window)
    if (space.windows.length > 0) return

    spaces.remove(space)
    // Nothing running and no space left: an empty screen would just be a dead
    // end, so exiting is the honest outcome.
    if (spaces.spaces.length === 0) void shutdown()
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
  /** Compile error from the send-keys prompt's last submit. Kept separate from
   *  the request so a reject does not recreate it and wipe the user's input. */
  const [promptError, setPromptError] = createSignal<string>("")
  const [captureView, setCaptureView] = createSignal<CaptureView | null>(null)
  const [settingsSection, setSettingsSection] = createSignal<SettingsSection>("sidebar")
  const [settingsSelected, setSettingsSelected] = createSignal(0)
  const [settingsDirty, setSettingsDirty] = createSignal(false)
  /** True while the keybind editor is waiting for the keystroke to record. */
  const [capturing, setCapturing] = createSignal(false)
  const [conflicts, setConflicts] = createSignal<Conflict[]>([])
  const [paletteQuery, setPaletteQuery] = createSignal("")
  const [paletteSelected, setPaletteSelected] = createSignal(0)
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
      setPromptError("")
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
    // level of the tree. The copy-mode pane is stepped down first — the teardown
    // below can free its terminal, and nothing can catch a segfault.
    if (target.kind === "agent") {
      exitCopyModeFor(target.window.panes.filter((p) => p.agent === target.agent))
      target.window.killAgent(target.agent)
    } else if (target.kind === "window") {
      exitCopyModeFor(target.window.panes)
      target.space.closeWindow(target.window)
    } else {
      exitCopyModeFor(target.space.windows.flatMap((w) => w.panes))
      spaces.remove(target.space)
    }
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
    // A pane closing is a structural change; if it was the copy-mode pane, the
    // mode must step down rather than keep a handle on a destroyed view. Guarded
    // on the mode being active, since this runs on every output chunk.
    //
    // This is the safety net, not the first line of defence: the pane-destroying
    // commands step the mode down BEFORE they tear anything down (see
    // exitCopyModeFor), because here the pane may already be destroyed and its
    // terminal may already be freed. Reaching this with a freed terminal is the
    // one case left, and it does not happen: every path that frees a terminal
    // goes through a command that exits first, and agent exits never free theirs.
    const copyPane = copyMode.active ? copyMode.pane : null
    if (copyPane && !paneStillMounted(copyPane)) copyMode.exit()
    syncSidebarBorder()
  }

  /** Whether a pane still has a viewport anywhere, for the copy-mode orphan
   *  check above. Pane views close without ending their agent, so the terminal
   *  survives — but refresh() on a destroyed renderable does not. */
  function paneStillMounted(pane: TerminalPane): boolean {
    return spaces.spaces.some((s) => s.windows.some((w) => w.panes.includes(pane)))
  }

  /**
   * End copy mode before a structural change destroys its pane.
   *
   * Copy mode is pane-scoped and survives focus moves, so only the pane it sits
   * on matters — closing an unrelated pane or window leaves the review in place.
   * This must run BEFORE the teardown, never after: the mode's own exit clears
   * the selection through the pane's terminal, and that call is only safe while
   * the terminal is alive. A freed terminal cannot be caught — the FFI call
   * segfaults before the try/catch inside CopyMode.exit can see it.
   */
  function exitCopyModeFor(panes: TerminalPane | readonly TerminalPane[] | null) {
    const pane = copyMode.pane
    if (!pane || !panes) return
    const affected = Array.isArray(panes) ? panes.includes(pane) : panes === pane
    if (affected) copyMode.exit()
  }

  function toggleSidebar() {
    const open = !sidebarOpen()
    setSidebarOpen(open)
    if (!open) setSidebarFocused(false)
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
    } else if (section === "appearance") {
      next.appearance.paneGap = Math.max(0, Math.min(8, next.appearance.paneGap + delta))
    }
    setConfigState(next)
    applyConfig(next)
    if (section === "appearance") spaces.refreshChrome()
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

  /**
   * Enter keyboard copy mode on the focused pane.
   *
   * The mode reads only — it scrolls the viewport and drives the terminal's
   * selection highlight, and never writes a byte to the child, so the process
   * keeps running and its output stays live underneath the review.
   */
  function enterCopyMode() {
    const pane = spaces.activeWindow?.focused
    if (!pane) return
    copyMode.enter(pane)
  }

  /**
   * A capture command's target: the focused pane, else the sidebar's selected
   * agent. Capture only reads a terminal, so — unlike send-keys — the selected
   * agent needs no viewport: a detached agent is captured as it is, without
   * being revealed or otherwise touched.
   */
  function captureTarget(): CaptureTarget | null {
    const focused = spaces.activeWindow?.focused?.agent ?? null
    const selection = targets()[selected()]
    const selectedAgent = selection?.kind === "agent" ? selection.agent : null
    return pickCaptureTarget(
      focused ? { term: focused.term, describe: () => focused.title || "pane" } : null,
      selectedAgent
        ? { term: selectedAgent.term, describe: () => selectedAgent.title || "pane" }
        : null,
    )
  }

  /**
   * Capture the focused or selected pane and open its destination.
   *
   * The popup is tmux's capture-pane followed by save-buffer: it shows exactly
   * what was captured and `s` writes it to the shown path. `f` re-captures the
   * other span (visible ↔ scrollback) into the same buffer, so both reaches of
   * the terminal are one `s` away. Nothing is written until then, and capturing
   * never touches the terminal — a detached agent is as capturable as the pane
   * in front of you.
   */
  function openCapture() {
    const target = captureTarget()
    if (!target) {
      setPromptError("")
      setPromptRequest({
        title: "capture",
        notice: "no pane to capture",
        fields: [],
        resolve: () => setPromptRequest(null),
      })
      return
    }
    const dir = spaces.active?.dir ?? process.cwd()
    const name = target.describe().replace(/[^\w.-]+/g, "-") || "pane"
    const path = join(dir, `capture-${name}-${Date.now()}.txt`)
    const open = (span: CaptureSpan) => {
      const content = captureSpan(target.term, span)
      setCaptureView({
        title: `captured pane: ${target.describe()}`,
        content,
        path,
        span,
        saved: false,
        onToggleSpan: () => open(span === "scrollback" ? "visible" : "scrollback"),
        onSave: () => {
          writeFileSync(path, content)
          setCaptureView((view) => (view ? { ...view, saved: true } : view))
        },
        onClose: () => setCaptureView(null),
      })
    }
    open("visible")
  }

  /**
   * The pane send-keys targets: the focused pane, or the sidebar's selected
   * agent when nothing is focused. Selected agents are revealed first — a row is
   * only a "selected pane" once it has a viewport keystrokes can land in.
   */
  function sendKeysTarget(): SendTarget | null {
    const focused = spaces.activeWindow?.focused ?? null
    const selection = targets()[selected()]
    const focusedTarget = focused
      ? {
          write: (b: string) => focused.write(b),
          describe: () => focused.agent.title || "pane",
        }
      : null
    const selectedTarget =
      selection?.kind === "agent"
        ? {
            write: (b: string) => selection.window.reveal(selection.agent)?.write(b),
            describe: () => selection.agent.title || "pane",
          }
        : null
    return pickSendTarget(focusedTarget, selectedTarget, () => {
      if (selection?.kind !== "agent") return
      if (selection.space !== spaces.active) spaces.activate(selection.space)
      selection.space.selectWindow(selection.window)
    })
  }

  /**
   * ^a : — tmux's command prompt, for tmux's send-keys.
   *
   * The prompt names its target up front, so "where did that go" is answered
   * before the keystroke is typed. A rejected input keeps the prompt open with
   * the reason in it — an empty or misquoted string is a typo to fix, not a
   * command to retype — while a missing target is a plain notice. Injected bytes
   * go to the pane's own write path, so app bindings never see them.
   */
  function sendKeysCommand() {
    const target = sendKeysTarget()
    if (!target) {
      setPromptError("")
      setPromptRequest({
        title: "send-keys",
        notice: "no pane to send to",
        fields: [],
        resolve: () => setPromptRequest(null),
      })
      return
    }
    setPromptError("")
    setPromptRequest({
      title: `send-keys → ${target.describe()}`,
      footer: "keys: Enter, Escape, ctrl+a, space · text: 'ls -la' Enter · esc cancel",
      fields: [{ label: "keys", placeholder: "e.g. 'ls -la' Enter" }],
      resolve: (values) => {
        const error = sendKeys(target, values?.[0] ?? "", parseKeyStrokes.bind(null, bindings.keymap))
        if (error) setPromptError(error.message)
        else setPromptRequest(null)
      },
    })
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
        if (w?.focused) {
          exitCopyModeFor(w.focused)
          w.close(w.focused)
        }
      },
    },
    {
      name: "pane.capture",
      // shift+c: plain ^a c is new window, and this is near pane.close's ^a x.
      key: "<leader>shift+c",
      desc: "capture the focused pane (s saves)",
      group: "panes",
      run: openCapture,
    },
    {
      name: "pane.copy-mode",
      key: "<leader>[",
      desc: "copy mode: review pane history (v selects, y copies)",
      group: "panes",
      run: enterCopyMode,
    },
    {
      name: "pane.send-keys",
      // The command remains available from the palette; prefix+colon now opens it.
      desc: "send keys to the focused pane (tmux send-keys)",
      group: "panes",
      run: sendKeysCommand,
    },
    {
      // The binding tmux itself gives break-pane.
      name: "pane.break",
      key: "<leader>!",
      desc: "break the focused pane into its own window",
      group: "panes",
      run: () => {
        const w = activeWin()
        if (w?.focused) spaces.active?.breakPane(w.focused)
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
        if (space && w) {
          exitCopyModeFor(w.panes)
          space.closeWindow(w)
        }
      },
    },
    {
      // tmux's next-layout, on tmux's own binding.
      name: "window.next-layout",
      key: "<leader>space",
      desc: "cycle through the preset layouts",
      group: "windows",
      run: () => {
        const w = activeWin()
        if (w) {
          exitCopyModeFor(w.panes)
          w.selectLayout(nextPreset(w.preset))
        }
      },
    },
    // Each preset is addressable on its own, so a keymap can bind one directly
    // and a command layer can name it — tmux's select-layout <name>.
    ...LAYOUT_PRESETS.map((preset: LayoutPreset, i) => ({
      name: `window.select-layout.${preset}`,
      desc: i === 0 ? "arrange panes in a preset layout" : `arrange panes: ${preset}`,
      hidden: i > 0,
      group: "windows",
      run: () => {
        const w = activeWin()
        if (w) {
          exitCopyModeFor(w.panes)
          w.selectLayout(preset)
        }
      },
    })),
    {
      name: "window.synchronize-panes",
      key: "<leader>y",
      desc: "toggle synchronize-panes (input to every pane)",
      group: "windows",
      run: () => activeWin()?.toggleSync(),
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
        const pane = w?.focused
        if (pane) {
          exitCopyModeFor(w.panes.filter((p) => p.agent === pane.agent))
          w.killAgent(pane.agent)
        }
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
      name: "app.command-palette",
      key: "<leader>:",
      desc: "search and run commands",
      group: "global",
      run: () => {
        setPaletteQuery("")
        setPaletteSelected(0)
        setOverlay("palette")
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
        if (bytes) activeWin()?.write(bytes)
      },
    },
    { name: "app.quit", key: "<leader>q", desc: "quit", group: "global", run: () => void shutdown() },
  ]

  /**
   * Keys not claimed by a binding belong to the child — except while a modal or
   * the sidebar has focus. Returns whether the app consumed the key; see the
   * note on preventDefault in bindings.ts.
   */
  function onUnhandled(event: KeyEvent): boolean {
    if (promptRequest()) {
      const request = promptRequest()!
      // A notice is a message, not a form: nothing is focused to hand the key to,
      // so every key is consumed here and enter/escape dismiss it.
      if (request.notice) {
        if (event.name === "escape" || event.name === "return" || event.name === "enter") {
          request.resolve(null)
        }
        return true
      }
      // Escape cancels; everything else belongs to the focused input, so leave
      // the event alone and let focus routing deliver it.
      if (event.name === "escape") {
        request.resolve(null)
        return true
      }
      return false
    }
    if (captureView()) {
      // The capture popup is its own modal: s writes the file, f re-captures
      // the other span, escape backs out without saving. Everything else stays
      // with the popup.
      const view = captureView()!
      if (event.name === "s") view.onSave()
      else if (event.name === "f") view.onToggleSpan()
      else if (event.name === "escape") view.onClose()
      return true
    }
    if (overlay() !== "none") {
      if (event.name === "escape") {
        setOverlay("none")
        return true
      }
      if (overlay() === "settings") {
        if (event.name === "q") setOverlay("none")
        else settingsKey(event)
        return true
      }
      return paletteKey(event)
    }
    // Copy mode owns the focused pane's unhandled keys. Bound keys never reach
    // here, so the leader and every ^a sequence keep their normal meaning — and
    // a pane that is not in copy mode still gets its child's keystrokes, which
    // is how copy mode survives a ^a pane-focus away from it.
    if (copyMode.active && copyMode.pane === spaces.activeWindow?.focused) {
      return copyMode.onKey(event)
    }
    if (sidebarFocused()) {
      sidebarKey(event)
      return true
    }
    const bytes = encodeKey(event)
    if (bytes !== null) activeWin()?.write(bytes)
    return true
  }

  function paletteKey(event: KeyEvent) {
    const count = filteredPalette().length
    switch (event.name) {
      case "up":
        if (count) setPaletteSelected((s) => Math.max(0, s - 1))
        return true
      case "down":
        if (count) setPaletteSelected((s) => Math.min(count - 1, s + 1))
        return true
      case "pageup":
        if (count) setPaletteSelected((s) => Math.max(0, s - 10))
        return true
      case "pagedown":
        if (count) setPaletteSelected((s) => Math.min(count - 1, s + 10))
        return true
    }
    // Let text and Enter reach the focused input renderable.
    return false
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
  const allPaletteEntries = createMemo(() => paletteEntries(bindings, COMMANDS))
  const filteredPalette = createMemo(() => filterPaletteEntries(allPaletteEntries(), paletteQuery()))

  function submitPalette() {
    const entry = filteredPalette()[paletteSelected()]
    if (!entry) return
    setOverlay("none")
    bindings.dispatch(entry.name)
  }

  /** Whether the focused window's tab carries the copy-mode marker. Reads the
   *  copy-mode pane directly and refreshes on app revision, which copy-mode
   *  entry and exit bump through onStateChange. */
  const copying = createMemo(() => {
    const pane = copyMode.pane
    return pane !== null && (spaces.activeWindow?.panes.includes(pane) ?? false)
  })

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

  /**
   * Leave, without taking the agents with us.
   *
   * This is a detach, and it is the behaviour the daemon exists to provide:
   * spaces are NOT disposed, because disposing an agent kills its process, and
   * the process is the one thing that must survive. The workspace is recorded
   * first so the next client rebuilds the same arrangement over the same
   * still-running agents.
   *
   * Ending the session for real is `session.stop()`, not this.
   *
   * All this does now is ask. The recording, the socket and the renderer are
   * released by main.tsx's finalizers, which is what lets a SIGTERM save the
   * workspace — the thing this could never do while it was the only exit path.
   */
  function shutdown() {
    quit()
  }

  // Before the first window exists, so its panes are built with the right edges.
  syncSidebarFrame()
  // The daemon's workspace is restored in place of the default space. Nothing was
  // saved on a first run, and a session whose spaces were all closed is the same
  // thing: either way the fallback is one space on the current directory.
  //
  // Agents the daemon is still running are adopted rather than re-run — the
  // backend knows which ones those are — so a reattach puts the live processes
  // back under the same window numbers and the same split arrangement.
  if (!session.session || restoreSession(spaces, session.session).length === 0) {
    const first = spaces.create(basename(process.cwd()) || "space", process.cwd())
    first.newWindow().init()
  }
  syncSidebarFrame()
  void refreshGit()
  const gitTimer = setInterval(() => void refreshGit(), 5000)
  gitTimer.unref?.()
  const View = () => (
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
      paletteEntries={filteredPalette()}
      paletteQuery={paletteQuery()}
      paletteSelected={paletteSelected()}
      onPaletteInput={(value) => {
        setPaletteQuery(value)
        setPaletteSelected(0)
      }}
      onPaletteSubmit={submitPalette}
      capturing={capturing()}
      settingsSection={settingsSection()}
      settingsSelected={settingsSelected()}
      settingsDirty={settingsDirty()}
      onKeybindList={(box) => {
        keybindList = box
      }}
      prompt={promptRequest()}
      promptError={promptError()}
      captureView={captureView()}
      copying={copying()}
    />
  )

  /**
   * Stop everything this function started.
   *
   * Deliberately NOT a detach: the spaces are left alone, because disposing an
   * agent kills its process. Only our own observers and timers go, and the
   * workspace is written by `persist` from the session's finalizer afterwards.
   */
  function dispose() {
    // While the pane is still alive: the mode's exit clears the selection
    // through the pane's terminal, and a freed terminal cannot be caught.
    if (copyMode.active) copyMode.exit()
    clearInterval(copyTimer)
    clearInterval(gitTimer)
    if (saveTimer) clearTimeout(saveTimer)
    app.dispose()
  }

  return { View, persist: persistSession, dispose }
}
