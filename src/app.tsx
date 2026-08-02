/** @jsxImportSource @opentui/solid */
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { createSignal, createMemo, createEffect } from "solid-js"
import { Effect } from "effect"
import { basename, join, resolve } from "node:path"
import { writeFile } from "node:fs/promises"

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
import {
  COMMAND_META,
  CommandError,
  command,
  makeCommands,
  runDetached,
  type Command,
  type CommandHandlers,
  type CommandTag,
} from "./commands.ts"
import { saveConfig, applyConfig, type Config } from "./config.ts"
import type { SessionClientShape } from "./client.ts"
import { restoreSession, snapshotSpace } from "./snapshot.ts"
import { createAppState } from "./ui/state.ts"
import { clampSidebarSelection, sidebarTargets } from "./ui/Sidebar.tsx"
import { App, type Overlay } from "./ui/App.tsx"
import { hintVisibility } from "./ui/Hints.tsx"
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

  /**
   * Run one of the workspace's Effect-returning methods here and now.
   *
   * Commands no longer need this — a CommandSpec's `run` is an Effect, so it
   * yields. What is left are the callers that are not commands and cannot be:
   * boot, and the prompt flows, which are `async` because they await an answer
   * from a Solid signal rather than from Effect.
   */
  const run = <A,>(effect: Effect.Effect<A>): A => Effect.runSync(effect)

  /**
   * Start a releasing effect and let it finish on its own.
   *
   * Releasing cannot be `run`: closing an agent's scope interrupts its pump
   * fiber before freeing the terminal, and interrupting a running fiber means
   * waiting for it to unwind — `runSync` throws on it. A callback has nowhere
   * to await, so it forks.
   *
   * Which makes the SHAPE of a caller matter: anything that reads the tree
   * after a release must do so inside the same effect, not after this call.
   * Forking only guarantees the effect starts, which is how ts-456094's eight
   * dropped Effects hid for as long as they did.
   *
   * The two remaining callers are the agent-exit cascade and the sidebar's `x`,
   * neither of which is a command today. The sidebar's is a duplicate of
   * agent.kill / window.close / space.close aimed at the selected row instead
   * of the active one, and it collapses into those the moment commands take
   * arguments — the Schema half of ts-8b3867.
   */
  const fork = (effect: Effect.Effect<unknown>): void => void Effect.runFork(effect)

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
   * What to do after an agent is finished and its views have closed.
   *
   * An agent ending triggers this, whether it ended on its own or was killed
   * with ^a K — the two are the same event from here, and letting them diverge
   * is what left ^a K with an empty window (ts-8d06b3). What does NOT trigger
   * it is closing a view with ^a x: that is a deliberate detach, the agent keeps
   * running, and reopening it would fight the user. The difference that matters
   * is whether anything is still running, not who ended it.
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
    // One effect, not three forks: each step's condition is read from the tree
    // the previous step just changed, so the sequencing has to be inside.
    fork(
      Effect.gen(function* () {
        yield* space.closeWindow(window)
        if (space.windows.length > 0) return
        yield* spaces.remove(space)
        // Nothing running and no space left: an empty screen would just be a
        // dead end, so exiting is the honest outcome.
        if (spaces.spaces.length === 0) shutdown()
      }),
    )
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
    setSettingsError("")
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
  const [selected, setSelected] = createSignal(0)
  const [hovered, setHovered] = createSignal<number | null>(null)
  const [overlay, setOverlay] = createSignal<Overlay>("none")
  // The raw compiled parts, not a formatted string: the which-key panel has to
  // match them against every binding's sequence to work out what is still
  // reachable, and a display string cannot be matched back.
  const [pendingParts, setPendingParts] = createSignal<readonly { display: string }[]>([])
  const [hintsVisible, setHintsVisible] = createSignal(false)
  let hintTimer: ReturnType<typeof setTimeout> | null = null
  const [promptRequest, setPromptRequest] = createSignal<PromptRequest | null>(null)
  /** Compile error from the send-keys prompt's last submit. Kept separate from
   *  the request so a reject does not recreate it and wipe the user's input. */
  const [promptError, setPromptError] = createSignal<string>("")
  const [captureView, setCaptureView] = createSignal<CaptureView | null>(null)
  const [settingsSection, setSettingsSection] = createSignal<SettingsSection>("sidebar")
  const [settingsSelected, setSettingsSelected] = createSignal(0)
  const [settingsDirty, setSettingsDirty] = createSignal(false)
  const [settingsError, setSettingsError] = createSignal("")
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

  const targets = createMemo(() => {
    // agentKind is polled, so keyboard targets must refresh with the rendered rows.
    app.tick()
    return sidebarTargets(app.spaces(), configState().sidebar.agentsOnly)
  })
  createEffect(() => {
    const count = targets().length
    setSelected((current) => clampSidebarSelection(current, count))
  })
  const activeWin = () => spaces.activeWindow

  /**
   * Open a modal prompt and answer with the field values, or null on cancel.
   *
   * An Effect rather than a Promise because its callers are the prompt-driven
   * *bindings*, and a binding's body is an Effect that ends in a command. The
   * synchronous prefix still puts the prompt on screen in the keypress that
   * asked for it; only the answer waits.
   */
  function ask(title: string, fields: PromptRequest["fields"]): Effect.Effect<string[] | null> {
    return Effect.async<string[] | null>((resume) => {
      setPromptError("")
      setPromptRequest({
        title,
        fields,
        resolve: (values) => {
          setPromptRequest(null)
          resume(Effect.succeed(values))
        },
      })
      // Interrupting the binding takes the prompt down with it rather than
      // leaving a modal nobody is waiting on.
      return Effect.sync(() => setPromptRequest(null))
    })
  }

  /**
   * The prompt-driven bindings: collect an argument, then invoke the command
   * that takes it.
   *
   * This is tmux's `command-prompt -I "#W" "rename-window '%%'"` — the prompt
   * is a property of the keybinding, not of the verb. `window.rename { name }`
   * is a command a socket or an agent can invoke; asking a human to type the
   * name is what `^a ,` adds on top of it.
   */
  const promptNewSpace = Effect.gen(function* () {
    const cwd = spaces.active?.dir ?? process.cwd()
    const answers = yield* ask("New space", [
      { label: "Name", value: basename(cwd), placeholder: "space name" },
      { label: "Directory", value: cwd, placeholder: "path" },
    ])
    if (!answers) return
    // Empty fields are left out entirely: "keep the default" is the command's
    // own answer to an absent argument, not a second rule written here.
    yield* commands.run(command("space.new", { name: answers[0], dir: answers[1] }))
  })

  const promptRenameSpace = Effect.gen(function* () {
    const space = spaces.active
    if (!space) return
    const answers = yield* ask("Rename space", [{ label: "Name", value: space.name }])
    if (!answers) return
    yield* commands.run(command("space.rename", { space: space.id, name: answers[0] ?? "" }))
  })

  const promptRenameWindow = Effect.gen(function* () {
    const space = spaces.active
    const window = space?.active
    if (!space || !window) return
    const answers = yield* ask("Rename window", [
      { label: "Name", value: window.customName ?? "", placeholder: window.title },
    ])
    if (!answers) return
    // Named rather than left implicit: the answer arrives whenever the user
    // finishes typing, and "the active window" may have moved by then.
    yield* commands.run(
      command("window.rename", { space: space.id, window: window.number, name: answers[0] ?? "" }),
    )
  })

  /** Act on the sidebar selection: a space row switches space, an agent row
   *  focuses or opens a view of it. */
  function activateSelection(index = selected()) {
    const target = targets()[index]
    if (!target) return
    setSelected(index)
    if (target.space !== spaces.active) spaces.activate(target.space)
    if (target.kind !== "space") target.space.selectWindow(target.window)
    if (target.kind === "agent") target.window.reveal(target.agent)
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
    setSidebarOpen(!sidebarOpen())
    syncSidebarFrame()
  }

  function toggleAgentsOnly() {
    setConfigState((c) => ({
      ...c,
      sidebar: { ...c.sidebar, agentsOnly: !c.sidebar.agentsOnly },
    }))
    setSettingsError("")
    setSettingsDirty(true)
  }

  function editSetting(delta: number) {
    const next = structuredClone(configState())
    const section = settingsSection()
    const field = settingsSelected()
    if (section === "sidebar") {
      if (field === 0) {
        next.sidebar.width = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, next.sidebar.width + delta))
      }
      else if (field === 1) next.sidebar.open = !next.sidebar.open
      else next.sidebar.agentsOnly = !next.sidebar.agentsOnly
    } else if (section === "behaviour") {
      if (field === 0) {
        next.behaviour.scrollRows = Math.max(1, Math.min(20, next.behaviour.scrollRows + delta))
      }
    } else if (section === "appearance") {
      if (field === 0) {
        next.appearance.paneGap = Math.max(0, Math.min(8, next.appearance.paneGap + delta))
      } else if (field === 1) {
        next.appearance.whichKeyHints = !next.appearance.whichKeyHints
      } else {
        next.appearance.whichKeyDelay = Math.max(0, Math.min(5, next.appearance.whichKeyDelay + delta))
      }
    }
    setConfigState(next)
    setSettingsError("")
    applyConfig(next)
    if (section === "appearance") spaces.refreshChrome()
    if (section === "appearance") updateHintVisibility(pendingParts(), next.appearance)
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
    setSettingsError("")
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
          void writeFile(path, content)
            .then(() => setCaptureView((view) => (view ? { ...view, saved: true, error: undefined } : view)))
            .catch((error: unknown) => {
              setCaptureView((view) =>
                view
                  ? {
                      ...view,
                      error: `could not save capture to ${path}: ${error instanceof Error ? error.message : String(error)}`,
                    }
                  : view,
              )
            })
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
  const promptSendKeys = Effect.sync(() => {
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
      // Not `ask`: a rejected input keeps this prompt open with the reason in
      // it, so the resolver has to see the command's failure rather than close
      // over the answer. Cancelling closes — escape used to be answered with
      // "nothing to send", which read as a rejection of a value nobody typed.
      resolve: (values) => {
        if (values === null) return setPromptRequest(null)
        const failure = Effect.runSync(
          commands.run(command("pane.send-keys", { keys: values[0] ?? "" })).pipe(
            Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }),
          ),
        )
        if (failure) setPromptError(failure)
        else setPromptRequest(null)
      },
    })
  })

  /**
   * Which window, space or agent a command is aimed at.
   *
   * An absent target means the active one, which is what a keypress means. A
   * target that is named and not found is a failure rather than a shrug: over
   * the socket that is a typo worth an answer, whereas `^a z` with no window at
   * all has always been a no-op and stays one.
   */
  function findSpace(id: string | undefined): Effect.Effect<Space | null, CommandError> {
    if (id === undefined) return Effect.succeed(spaces.active)
    const space = spaces.spaces.find((s) => s.id === id)
    return space ? Effect.succeed(space) : Effect.fail(new CommandError({ message: `no space '${id}'` }))
  }

  function findWindow(target: {
    space?: string | undefined
    window?: number | undefined
  }): Effect.Effect<{ space: Space; window: Window } | null, CommandError> {
    return Effect.flatMap(findSpace(target.space), (space) => {
      if (!space) return Effect.succeed(null)
      if (target.window === undefined) {
        return Effect.succeed(space.active ? { space, window: space.active } : null)
      }
      const window = space.windows.find((w) => w.number === target.window)
      return window
        ? Effect.succeed({ space, window })
        : Effect.fail(new CommandError({ message: `no window ${target.window} in '${space.name}'` }))
    })
  }

  function findAgent(id: string | undefined): Effect.Effect<{ window: Window; agent: Agent } | null, CommandError> {
    if (id === undefined) {
      const window = activeWin()
      const agent = window?.focused?.agent
      return Effect.succeed(window && agent ? { window, agent } : null)
    }
    for (const space of spaces.spaces) {
      for (const window of space.windows) {
        const agent = window.agents.find((a) => a.id === id)
        if (agent) return Effect.succeed({ window, agent })
      }
    }
    return Effect.fail(new CommandError({ message: `no agent '${id}'` }))
  }

  /**
   * What each verb does.
   *
   * Total over the command union, so declaring a command and forgetting to
   * implement it is a type error. Every surface — the keymap below, the sidebar,
   * and the control socket in ts-14b665 — reaches these through `commands.run`,
   * which is the point: there is one definition of what `agent.kill` means and
   * one place it can be got wrong.
   */
  const handlers: CommandHandlers = {
    // Suspended rather than `sync`: the window has to be read when the command
    // runs, not when the table is built.
    "pane.split": ({ axis }) => Effect.suspend(() => activeWin()?.splitSpawn(axis) ?? Effect.void),
    "pane.next": () => Effect.sync(() => activeWin()?.focusNext(1)),
    "pane.focus": ({ direction }) => Effect.sync(() => activeWin()?.focusDirection(direction)),
    "pane.zoom": () => Effect.sync(() => activeWin()?.zoom()),
    "pane.swap": ({ to }) => Effect.sync(() => activeWin()?.swap(to === "next" ? 1 : -1)),
    "pane.close": () =>
      Effect.sync(() => {
        const w = activeWin()
        if (!w?.focused) return
        exitCopyModeFor(w.focused)
        w.close(w.focused)
      }),
    "pane.break": () =>
      Effect.gen(function* () {
        const w = activeWin()
        const space = spaces.active
        if (w?.focused && space) yield* space.breakPane(w.focused)
      }),
    "pane.send-keys": ({ keys }) =>
      Effect.suspend(() => {
        const target = sendKeysTarget()
        if (!target) return Effect.fail(new CommandError({ message: "no pane to send to" }))
        const error = sendKeys(target, keys, parseKeyStrokes.bind(null, bindings.keymap))
        return error ? Effect.fail(new CommandError({ message: error.message })) : Effect.void
      }),
    "pane.capture": () => Effect.sync(openCapture),
    "pane.copy-mode": () => Effect.sync(enterCopyMode),

    "window.new": () =>
      Effect.gen(function* () {
        const space = spaces.active
        if (!space) return
        const window = yield* space.newWindow()
        yield* window.init()
      }),
    "window.next": () => Effect.sync(() => spaces.active?.cycleWindow(1)),
    "window.previous": () => Effect.sync(() => spaces.active?.cycleWindow(-1)),
    "window.select": ({ space, number }) =>
      Effect.flatMap(findSpace(space), (found) => Effect.sync(() => void found?.selectNumber(number))),
    "window.rename": ({ name, ...target }) =>
      Effect.flatMap(findWindow(target), (found) =>
        Effect.sync(() => {
          if (!found) return
          // Clearing the name hands the title back to whatever the window is
          // running, which is the only way to undo a rename.
          found.window.customName = name.trim() || null
          app.refresh()
        }),
      ),
    "window.close": (target) =>
      Effect.gen(function* () {
        const found = yield* findWindow(target)
        if (!found) return
        exitCopyModeFor(found.window.panes)
        yield* found.space.closeWindow(found.window)
        app.refresh()
      }),
    "window.next-layout": () =>
      Effect.sync(() => {
        const w = activeWin()
        if (!w) return
        exitCopyModeFor(w.panes)
        w.selectLayout(nextPreset(w.preset))
      }),
    "window.select-layout": ({ preset }) =>
      Effect.sync(() => {
        const w = activeWin()
        if (!w) return
        exitCopyModeFor(w.panes)
        w.selectLayout(preset)
      }),
    "window.synchronize-panes": () => Effect.sync(() => activeWin()?.toggleSync()),

    "agent.kill": ({ agent }) =>
      Effect.gen(function* () {
        const found = yield* findAgent(agent)
        if (!found) return
        // Before the teardown, never after: the mode's exit clears the selection
        // through the pane's terminal, and a freed terminal cannot be caught.
        exitCopyModeFor(found.window.panes.filter((p) => p.agent === found.agent))
        yield* found.window.killAgent(found.agent)
        app.refresh()
      }),
    "agent.next-blocked": () =>
      Effect.sync(() => {
        const agent = spaces.nextBlocked()
        if (!agent) return
        const index = targets().findIndex((target) => target.kind === "agent" && target.agent === agent)
        if (index !== -1) setSelected(index)
      }),

    "space.new": ({ name, dir }) =>
      Effect.gen(function* () {
        // An absent or empty field means "the default" rather than "blank".
        const cwd = spaces.active?.dir ?? process.cwd()
        const target = resolve(dir?.trim() || cwd)
        const space = yield* spaces.create(name?.trim() || basename(target), target)
        spaces.activate(space)
        const window = yield* space.newWindow()
        yield* window.init()
        void refreshGit()
      }),
    "space.rename": ({ space, name }) =>
      Effect.flatMap(findSpace(space), (found) =>
        Effect.sync(() => {
          if (!found || !name.trim()) return
          found.name = name.trim()
          app.refresh()
        }),
      ),
    "space.close": ({ space }) =>
      Effect.gen(function* () {
        const found = yield* findSpace(space)
        if (!found) return
        exitCopyModeFor(found.windows.flatMap((w) => w.panes))
        yield* spaces.remove(found)
        app.refresh()
      }),
    "space.next": () => Effect.sync(() => spaces.cycle(1)),
    "space.previous": () => Effect.sync(() => spaces.cycle(-1)),

    "sidebar.toggle": () => Effect.sync(toggleSidebar),
    "sidebar.toggle-agents-only": () => Effect.sync(toggleAgentsOnly),
    "app.help": () =>
      Effect.sync(() => {
        // The same window as settings, on its keybinds tab. Two overlays
        // rendering the same list from the same data was one overlay too many
        // to teach.
        if (overlay() === "settings" && settingsSection() === "keybinds") return setOverlay("none")
        setSettingsSection("keybinds")
        setSettingsSelected(0)
        setOverlay("settings")
      }),
    "app.command-palette": () =>
      Effect.sync(() => {
        setPaletteQuery("")
        setPaletteSelected(0)
        setOverlay("palette")
      }),
    "app.settings": () =>
      Effect.sync(() => {
        if (overlay() === "settings") return setOverlay("none")
        // Opening settings should land on settings, not on wherever ^a ? left
        // the tab last time.
        if (settingsSection() === "keybinds") setSettingsSection("sidebar")
        setSettingsSelected(0)
        setOverlay("settings")
      }),
    "app.send-prefix": () =>
      Effect.sync(() => {
        const bytes = leaderBytes(bindings.leader())
        if (bytes) activeWin()?.write(bytes)
      }),
    "app.quit": () => Effect.sync(shutdown),
  }

  const commands = makeCommands(handlers)

  /**
   * One keybinding: a name, the keys that reach it, and the command it invokes
   * with its arguments supplied.
   *
   * `desc` and `group` come from the command unless the binding says otherwise,
   * because a binding that supplies an argument often reads better than the verb
   * does — `^a |` is "split left/right", not "split the focused pane".
   */
  function bind(
    name: string,
    key: string | string[] | undefined,
    cmd: Command,
    opts: { desc?: string; hidden?: boolean; fixed?: boolean } = {},
  ): CommandSpec {
    const meta = COMMAND_META[cmd._tag]
    return {
      name,
      ...(key === undefined ? {} : { key }),
      desc: opts.desc ?? meta.desc,
      group: meta.group,
      hidden: opts.hidden,
      fixed: opts.fixed,
      run: commands.run(cmd),
    }
  }

  /**
   * A binding that has to collect its argument before it can invoke anything.
   *
   * Named after the command it ends in, because that is what it runs; the
   * prompt is the part that only makes sense in front of a screen.
   */
  function bindPrompt(
    tag: CommandTag,
    key: string | string[] | undefined,
    open: Effect.Effect<void, CommandError>,
    desc?: string,
  ): CommandSpec {
    const meta = COMMAND_META[tag]
    return {
      name: tag,
      ...(key === undefined ? {} : { key }),
      desc: desc ?? meta.desc,
      group: meta.group,
      run: open,
    }
  }

  const COMMANDS: CommandSpec[] = [
    // Panes — splits keep the tmux-ish | and -, which read better than " and %.
    bind("pane.split-row", ["<leader>|", "<leader>\\"], command("pane.split", { axis: "row" }), {
      desc: "split left/right",
    }),
    bind("pane.split-column", "<leader>-", command("pane.split", { axis: "column" }), {
      desc: "split top/bottom",
    }),
    bind("pane.next", "<leader>o", command("pane.next"), { desc: "next pane" }),
    // Directional focus, tmux's select-pane. One command with a direction, four
    // bindings that supply one each: two sequences per direction read better in
    // the help as four rows than as one row listing eight keys.
    ...(
      [
        ["left", "h"],
        ["down", "j"],
        ["up", "k"],
        ["right", "l"],
      ] as const
    ).map(([direction, letter]) =>
      bind(
        `pane.focus-${direction}`,
        [`<leader>${letter}`, `<leader>${direction}`],
        command("pane.focus", { direction }),
        { desc: `focus pane ${direction}` },
      ),
    ),
    bind("pane.zoom", "<leader>z", command("pane.zoom"), {
      desc: "zoom the focused pane (Z in the tab)",
    }),
    bind("pane.swap-previous", "<leader>{", command("pane.swap", { to: "previous" }), {
      desc: "swap pane with the previous one",
    }),
    bind("pane.swap-next", "<leader>}", command("pane.swap", { to: "next" }), {
      desc: "swap pane with the next one",
    }),
    bind("pane.close", "<leader>x", command("pane.close"), {
      desc: "close pane (agent keeps running)",
    }),
    // shift+c: plain ^a c is new window, and this is near pane.close's ^a x.
    bind("pane.capture", "<leader>shift+c", command("pane.capture"), {
      desc: "capture the focused pane (s saves)",
    }),
    bind("pane.copy-mode", "<leader>[", command("pane.copy-mode"), {
      desc: "copy mode: review pane history (v selects, y copies)",
    }),
    // Available from the palette; prefix+colon opens it.
    bindPrompt(
      "pane.send-keys",
      undefined,
      promptSendKeys,
      "send keys to the focused pane (tmux send-keys)",
    ),
    // The binding tmux itself gives break-pane.
    bind("pane.break", "<leader>!", command("pane.break")),

    // Windows.
    bind("window.new", "<leader>c", command("window.new")),
    bind("window.next", "<leader>n", command("window.next")),
    bind("window.previous", "<leader>p", command("window.previous")),
    bindPrompt("window.rename", "<leader>,", promptRenameWindow, "rename window"),
    bind("window.close", "<leader>&", command("window.close"), {
      desc: "kill window and its agents",
    }),
    // tmux's next-layout, on tmux's own binding.
    bind("window.next-layout", "<leader>space", command("window.next-layout")),
    // Each preset is addressable on its own, so a keymap can bind one directly —
    // tmux's select-layout <name>. One command, five bindings.
    ...LAYOUT_PRESETS.map((preset: LayoutPreset, i) =>
      bind(
        `window.select-layout.${preset}`,
        undefined,
        command("window.select-layout", { preset }),
        i === 0 ? {} : { desc: `arrange panes: ${preset}`, hidden: true },
      ),
    ),
    bind("window.synchronize-panes", "<leader>y", command("window.synchronize-panes")),
    // 1..9 select by the window's own number, which is why that number is stable
    // rather than a position in the list. Nine bindings supplying an argument to
    // one command, which is exactly tmux's `bind-key 1 select-window -t 1`.
    ...Array.from({ length: 9 }, (_, i) =>
      bind(`window.select-${i + 1}`, `<leader>${i + 1}`, command("window.select", { number: i + 1 }), {
        desc: i === 0 ? "select window 1..9" : `select window ${i + 1}`,
        // Listed once, on the first; see CommandSpec.hidden for why this is a
        // flag and not an empty description.
        hidden: i > 0,
      }),
    ),

    // Agents.
    // shift+k: plain ^a k is directional pane focus, and killing an agent is not
    // something to put one keystroke away from "move up" anyway.
    bind("agent.kill", "<leader>shift+k", command("agent.kill"), { desc: "stop the focused agent" }),
    bind("agent.next-blocked", "<leader>a", command("agent.next-blocked"), {
      desc: "jump to the next blocked agent",
    }),

    // Spaces.
    bindPrompt("space.new", "<leader>s", promptNewSpace),
    bindPrompt("space.rename", "<leader>r", promptRenameSpace, "rename space"),
    bind("space.next", "<leader>)", command("space.next")),
    bind("space.previous", "<leader>(", command("space.previous")),
    bind("space.close", undefined, command("space.close")),

    // App.
    bind("sidebar.toggle", "<leader>b", command("sidebar.toggle"), { desc: "toggle sidebar" }),
    bind("sidebar.toggle-agents-only", undefined, command("sidebar.toggle-agents-only")),
    bind("app.help", ["<leader>?", "<leader>/"], command("app.help")),
    bind("app.command-palette", "<leader>:", command("app.command-palette")),
    // shift+s, not "S": a bare capital compiles to the same sequence as the
    // lowercase one, so this was silently shadowed by space.new's ^a s.
    bind("app.settings", "<leader>shift+s", command("app.settings")),
    // The prefix twice, written as the token so it follows a rebind — and sent
    // as whatever bytes that prefix actually produces. Not offered in the
    // editor: its sequence is the prefix, and the prefix row already edits that.
    bind("app.send-prefix", "<leader><leader>", command("app.send-prefix"), { fixed: true }),
    bind("app.quit", "<leader>q", command("app.quit")),
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
        void saveSettings()
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
        void saveSettings()
        return
    }
  }

  async function saveSettings() {
    try {
      await saveConfig(configState())
      setSettingsDirty(false)
      setSettingsError("")
    } catch (error) {
      setSettingsError(`could not save settings: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const bindings = createBindings(renderer, COMMANDS, { keys: config.keys, onUnhandled })
  setConflicts(bindings.conflicts())

  function clearHintTimer() {
    if (!hintTimer) return
    clearTimeout(hintTimer)
    hintTimer = null
  }

  function updateHintVisibility(
    sequence: readonly { display: string }[],
    appearance = configState().appearance,
  ) {
    clearHintTimer()
    setPendingParts(sequence)
    const visibility = hintVisibility(sequence.length, appearance.whichKeyHints, appearance.whichKeyDelay)
    if (!visibility.visible && visibility.delayMs === 0) {
      setHintsVisible(false)
      return
    }
    if (visibility.visible) {
      setHintsVisible(true)
      return
    }
    setHintsVisible(false)
    hintTimer = setTimeout(() => {
      hintTimer = null
      if (pendingParts().length) setHintsVisible(true)
    }, visibility.delayMs)
    hintTimer.unref?.()
  }

  // Only source of truth for the hint line and the which-key panel: what the
  // keymap will actually do next, so a rebinding shows up in both without
  // touching this file.
  bindings.keymap.on("pendingSequence", updateHintVisibility)

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
  if (!session.session || run(restoreSession(spaces, session.session)).length === 0) {
    const first = run(spaces.create(basename(process.cwd()) || "space", process.cwd()))
    run(Effect.flatMap(first.newWindow(), (w) => w.init()))
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
      selected={selected()}
      hovered={hovered()}
      onHover={setHovered}
      onActivate={activateSelection}
      pending={pending()}
      hints={hints()}
      hintsVisible={hintsVisible()}
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
      settingsError={settingsError()}
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
    clearHintTimer()
    if (saveTimer) clearTimeout(saveTimer)
    app.dispose()
  }

  return { View, persist: persistSession, dispose }
}
