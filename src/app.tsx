/** @jsxImportSource @opentui/solid */
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { createSignal, createMemo, createEffect, on } from "solid-js"
import { Effect, Fiber, Stream } from "effect"
import { basename, join, resolve } from "node:path"
import { writeFile } from "node:fs/promises"

import { Divider } from "./divider.ts"
import { projectWorkspace, SpaceSet } from "./space.ts"
import { frame } from "./window.ts"
import { nextPreset, LAYOUT_PRESETS, type LayoutPreset } from "./layout.ts"
import type { TerminalPane } from "./pane.ts"
import { readGit } from "./git.ts"
import { encodeKey } from "./keys.ts"
import { sendKeys, type SendTarget } from "./send.ts"
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
import { saveConfig, type Config } from "./config.ts"
import {
  OPTIONS,
  adjustedValue,
  applyOptions,
  clearOption,
  coerceOption,
  optionSpec,
  resolveOptions,
  writeOption,
  type OptionName,
  type OptionSpec,
  type OptionValue,
} from "./options.ts"
import type { SessionClientShape } from "./client.ts"
import type { WorkspaceSnapshot } from "./workspace.ts"
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
import { BufferChoose, type BufferChooseView } from "./ui/BufferChoose.tsx"
import { CopyMode } from "./copy.ts"
import type { BufferEntry } from "./effect/BufferStore.ts"
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
  const SHELL = [resolveOptions(config.options)["behaviour.shell"] || process.env.SHELL || "bash"]

  /**
   * Run one of the workspace's Effect-returning methods here and now.
   *
   * Commands no longer need this — a CommandSpec's `run` is an Effect, so it
   * yields. What is left are the callers that are not commands and cannot be:
   * boot, and the prompt flows, which are `async` because they await an answer
   * from a Solid signal rather than from Effect.
   */
  const run = <A,>(effect: Effect.Effect<A>): A => Effect.runSync(effect)

  /** A failure's message, whatever shape the socket threw it in. */
  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  const spaces = new SpaceSet(workspaceEnv(renderer, { shell: SHELL, backend: session.backend() }), paneHost)
  // Copy goes to the clipboard AND the server's buffer stack — tmux's model,
  // and what makes copy/paste work over ssh, between panes, and from a
  // script: the stack lives beside the daemon's PTYs, so paste needs no
  // attached client. The clipboard keeps its old verdict (a rejected OSC 52
  // is still a rejection); the push is best-effort and fire-and-forget, the
  // same as the clipboard write itself.
  spaces.onCopy = (text) => {
    void Effect.runPromise(session.setBuffer(undefined, text)).catch((error) =>
      console.error(`could not push paste buffer: ${String(error)}`),
    )
    return renderer.copyToClipboardOSC52(text)
  }
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

  let projectedRevision = -1
  let projection = Promise.resolve()
  let runProjectedCommand: (value: Command) => void = () => {}
  const project = (model: WorkspaceSnapshot): Promise<void> => {
    if (model.revision <= projectedRevision) return projection
    projectedRevision = model.revision
    projection = projection
      .then(() => Effect.runPromise(projectWorkspace(spaces, model, session.backend())))
      .then(() => {
        for (const space of spaces.spaces) {
          for (const window of space.windows) {
            window.onModelFocus = (pane) => runProjectedCommand(command("pane.select", { pane }))
            window.onModelResizeDivider = (path, index, delta) =>
              runProjectedCommand(command("pane.resize-divider", { path: [...path], index, delta }))
          }
        }
        app.refresh()
        if (model.spaces.length === 0) shutdown()
      })
      .catch((error) => console.error(`could not project workspace revision ${model.revision}: ${String(error)}`))
    return projection
  }
  const modelFiber = Effect.runFork(
    Stream.runForEach(session.models, (model) => Effect.promise(() => project(model))),
  )
  const workspaceContext = () => ({
    size: { cols: Math.max(1, paneHost.width), rows: Math.max(1, paneHost.height) },
    shell: SHELL,
    cwd: spaces.active?.dir ?? process.cwd(),
    blockedAgents: spaces.allAgents.filter((agent) => agent.state === "blocked").map((agent) => agent.id),
  })
  const runWorkspace = (value: Command, input?: string): Effect.Effect<void, CommandError> =>
    session.runWorkspace(value, { ...workspaceContext(), ...(input === undefined ? {} : { input }) }).pipe(
      Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
      Effect.tap((model) => Effect.promise(() => project(model))),
      Effect.asVoid,
    )

  const [configState, setConfigState] = createSignal<Config>(config)
  /** Every option resolved against its declared default — what the app reads.
   *  The config itself holds only what the user changed. */
  const options = createMemo(() => resolveOptions(configState().options))

  /**
   * Put a new value into an option.
   *
   * The one path for any change: a key, the settings window, a drag, the socket.
   * The clamping and the default-is-not-stored rule live in the table, so this
   * only decides what the change means for the screen — unsaved, and the last
   * save's error no longer describes what is on it.
   */
  function changeOption(name: OptionName, value: OptionValue) {
    setConfigState((c) => ({ ...c, options: writeOption(c.options, name, value) }))
    setSettingsError("")
    setSettingsDirty(true)
  }

  /** Move an option relative to where it is: ←/→ in settings, and the drag. */
  function adjustOption(name: OptionName, by: number) {
    changeOption(name, adjustedValue(OPTIONS[name], options()[name], by))
  }

  // A Divider rather than a component with mouse props: dragging a one-cell
  // target only works if the pointer is claimed on the press, and that is a
  // renderable-level concern. See the note in divider.ts.
  //
  // The width it drags IS the option the settings window edits, so a drag
  // survives a save and the two cannot disagree about how narrow is too narrow.
  const sidebarHandle = new Divider(renderer, {
    id: "sidebar-divider",
    axis: "row",
    onDrag: (delta) => adjustOption("sidebar.width", delta),
  })
  // It is the pane frame's left border, not a bare rule between two regions: it
  // finishes with corners and the panes beside it stop drawing a left edge, so
  // the seam is one column wide instead of two adjacent lines.
  sidebarHandle.tees = true
  sidebarHandle.outer = true
  sidebarHandle.capStart = true
  sidebarHandle.capEnd = true

  const sidebarOpen = () => options()["sidebar.open"]
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
  /** The choose-buffer overlay, when it is up. */
  const [chooseView, setChooseView] = createSignal<BufferChooseView | null>(null)
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
    return sidebarTargets(app.spaces(), options()["sidebar.agentsOnly"])
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
    const effect = target.kind === "space"
      ? commands.run(command("space.select", { space: target.space.id }))
      : target.kind === "agent"
        ? commands.run(command("agent.reveal", { agent: target.agent.id }))
        : commands.run(command("window.select", { space: target.space.id, number: target.window.number }))
    runDetached("sidebar.select", effect)
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

  /** The option the settings window's selection is sitting on, if any. */
  function selectedOption(): OptionName | undefined {
    return settingsFields(options(), settingsSection())[settingsSelected()]?.name
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
   * Open tmux's choose-buffer: the server's paste buffer stack as a picker.
   *
   * The list is whatever the daemon holds, so it is fetched here and then
   * owned by the overlay; a delete re-fetches the stack so the list stays
   * honest. Pasting targets the focused pane, exactly like buffer.paste.
   */
  function openChooseBuffer(buffers: readonly BufferEntry[]) {
    setChooseView({
      buffers: [...buffers],
      selected: 0,
      onPaste: (name) => {
        const pane = spaces.activeWindow?.focused
        if (pane) {
          void Effect.runPromise(session.pasteBuffer(name, pane.agent.id)).catch((error) =>
            console.error(`could not paste buffer '${name}': ${String(error)}`),
          )
        }
        setChooseView(null)
      },
      onDelete: (name) => {
        void Effect.runPromise(
          session.deleteBuffer(name).pipe(Effect.zipRight(session.listBuffers())),
        )
          .then((buffers) => {
            setChooseView((view) =>
              view
                ? {
                    ...view,
                    buffers: [...buffers],
                    selected: Math.min(view.selected, Math.max(0, buffers.length - 1)),
                  }
                : view,
            )
          })
          .catch((error) => console.error(`could not delete buffer '${name}': ${String(error)}`))
      },
      onClose: () => setChooseView(null),
    })
  }

  /**
   * The pane send-keys targets: the focused pane, or the sidebar's selected
   * agent when nothing is focused. Selected agents are revealed first — a row is
   * only a "selected pane" once it has a viewport keystrokes can land in.
   */
  function sendKeysTarget(): SendTarget | null {
    const focused = spaces.activeWindow?.focused ?? null
    const selection = targets()[selected()]
    if (focused) return { write() {}, describe: () => focused.agent.title || "pane" }
    return selection?.kind === "agent"
      ? { write() {}, describe: () => selection.agent.title || "pane" }
      : null
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

  /** The declaration behind an option name, or a refusal naming it. */
  function knownOption(name: string): Effect.Effect<{ spec: OptionSpec; option: OptionName }, CommandError> {
    const spec = optionSpec(name)
    if (!spec) return Effect.fail(new CommandError({ message: `no option '${name}'` }))
    return Effect.succeed({ spec, option: name as OptionName })
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
    "pane.split": (value) => runWorkspace(value),
    "pane.next": (value) => runWorkspace(value),
    "pane.last": (value) => runWorkspace(value),
    "pane.focus": (value) => runWorkspace(value),
    "pane.select": (value) => runWorkspace(value),
    "pane.resize": (value) => runWorkspace(value),
    "pane.resize-divider": (value) => runWorkspace(value),
    "pane.zoom": (value) => runWorkspace(value),
    "pane.swap": (value) => runWorkspace(value),
    "pane.close": (value) => runWorkspace(value),
    "pane.break": (value) => runWorkspace(value),
    "pane.send-keys": ({ keys }) =>
      Effect.suspend(() => {
        let input = ""
        const error = sendKeys(
          { write: (bytes) => { input += bytes }, describe: () => "pane" },
          keys,
          parseKeyStrokes.bind(null, bindings.keymap),
        )
        return error
          ? Effect.fail(new CommandError({ message: error.message }))
          : runWorkspace(command("pane.send-keys", { keys }), input)
      }),
    "pane.capture": () => Effect.sync(openCapture),
    "pane.copy-mode": () => Effect.sync(enterCopyMode),

    // The tmux paste-buffer family. The stack lives on the daemon; these
    // handlers are the local doors to it — the same RPC a script uses, minus
    // the parts that need a screen (the focused pane, the picker overlay).
    // The session methods fail with whatever the socket threw, so the message
    // is pulled out before it becomes a CommandError.
    "buffer.set": ({ name, data }) =>
      session.setBuffer(name, data).pipe(
        Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
        Effect.asVoid,
      ),
    "buffer.paste": ({ name }) =>
      Effect.gen(function* () {
        const pane = spaces.activeWindow?.focused
        if (!pane) return yield* Effect.fail(new CommandError({ message: "no pane to paste into" }))
        yield* session.pasteBuffer(name, pane.agent.id).pipe(
          Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
        )
      }),
    "buffer.list": () =>
      session.listBuffers().pipe(
        Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
        Effect.asVoid,
      ),
    "buffer.delete": ({ name }) =>
      session.deleteBuffer(name).pipe(
        Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
      ),
    "buffer.show": ({ name }) =>
      session.showBuffer(name).pipe(
        Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
        Effect.asVoid,
      ),
    "buffer.choose": () =>
      Effect.gen(function* () {
        const buffers = yield* session.listBuffers().pipe(
          Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
        )
        openChooseBuffer(buffers)
      }),

    "window.new": (value) => runWorkspace(value),
    "window.next": (value) => runWorkspace(value),
    "window.previous": (value) => runWorkspace(value),
    "window.last": (value) => runWorkspace(value),
    "window.select": (value) => runWorkspace(value),
    "window.rename": (value) => runWorkspace(value),
    "window.close": (value) => runWorkspace(value),
    "window.next-layout": (value) => runWorkspace(value),
    "window.select-layout": (value) => runWorkspace(value),
    "window.synchronize-panes": (value) => runWorkspace(value),

    "agent.kill": (value) => runWorkspace(value),
    "agent.reveal": (value) => runWorkspace(value),
    "agent.next-blocked": (value) => runWorkspace(value),

    "space.new": (value) => runWorkspace(value),
    "space.select": (value) => runWorkspace(value),
    "space.rename": (value) => runWorkspace(value),
    "space.close": (value) => runWorkspace(value),
    "space.next": (value) => runWorkspace(value),
    "space.previous": (value) => runWorkspace(value),

    // The name arrives as a string from every surface, so it is checked here
    // rather than trusted: the table is what says whether it exists and what it
    // will accept, and a refusal is a value the caller can show.
    "config.set": ({ name, value }) =>
      Effect.gen(function* () {
        const { spec, option } = yield* knownOption(name)
        const coerced = coerceOption(spec, value)
        if (coerced === undefined) {
          return yield* new CommandError({ message: `${name} does not take ${JSON.stringify(value)}` })
        }
        changeOption(option, coerced)
      }),
    "config.toggle": ({ name }) =>
      Effect.gen(function* () {
        const { spec, option } = yield* knownOption(name)
        if (spec.kind !== "boolean") {
          return yield* new CommandError({ message: `${name} is not a yes/no option` })
        }
        changeOption(option, !options()[option])
      }),
    "config.adjust": ({ name, by }) =>
      Effect.gen(function* () {
        const { option } = yield* knownOption(name)
        adjustOption(option, by)
      }),
    "config.reset": ({ name }) =>
      Effect.gen(function* () {
        const { option } = yield* knownOption(name)
        setConfigState((c) => ({ ...c, options: clearOption(c.options, option) }))
        setSettingsError("")
        setSettingsDirty(true)
      }),
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
  runProjectedCommand = (value) => runDetached(value._tag, commands.run(value))

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
    opts: { desc?: string; group?: string; hidden?: boolean; fixed?: boolean } = {},
  ): CommandSpec {
    const meta = COMMAND_META[cmd._tag]
    return {
      name,
      ...(key === undefined ? {} : { key }),
      desc: opts.desc ?? meta.desc,
      group: opts.group ?? meta.group,
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
    // tmux's last-pane: toggle to the pane you were just on.
    bind("pane.last", "<leader>;", command("pane.last"), { desc: "toggle to the last-focused pane" }),
    // Directional focus, tmux's select-pane. One command with a direction, four
    // bindings that supply one each: two sequences per direction read better in
    // the help as four rows than as one row listing eight keys. right has no
    // letter because ^a l is tmux's last-window, which took the spot.
    ...(
      [
        ["left", "h"],
        ["down", "j"],
        ["up", "k"],
        ["right", null],
      ] as const
    ).map(([direction, letter]) =>
      bind(
        `pane.focus-${direction}`,
        letter === null ? `<leader>${direction}` : [`<leader>${letter}`, `<leader>${direction}`],
        command("pane.focus", { direction }),
        { desc: `focus pane ${direction}` },
      ),
    ),
    // Keyboard resize, tmux's resize-pane. ctrl+arrow because the plain arrows
    // already move focus, exactly the way tmux ships both under one prefix.
    ...(
      [
        ["left", "ctrl+left"],
        ["down", "ctrl+down"],
        ["up", "ctrl+up"],
        ["right", "ctrl+right"],
      ] as const
    ).map(([direction, key]) =>
      bind(
        `pane.resize-${direction}`,
        `<leader>${key}`,
        command("pane.resize", { direction }),
        { desc: `resize pane ${direction}` },
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
    // tmux's own paste-buffer and choose-buffer bindings: ^a ] pastes the top
    // of the server-side stack into the focused pane, ^a = picks one.
    bind("buffer.paste", "<leader>]", command("buffer.paste"), {
      desc: "paste the top paste buffer into the focused pane",
    }),
    bind("buffer.choose", "<leader>=", command("buffer.choose"), {
      desc: "choose a paste buffer (enter pastes, d deletes)",
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
    // tmux's last-window, on tmux's own binding — which is also why focus-right
    // no longer answers to ^a l.
    bind("window.last", "<leader>l", command("window.last"), { desc: "toggle to the last window" }),
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
    // A binding names the option; there is no `sidebar.toggle` verb behind it.
    // The name is still the binding's identity, so the keybind editor and the
    // palette read exactly as they did when it was a command of its own.
    bind("sidebar.toggle", "<leader>b", command("config.toggle", { name: "sidebar.open" }), {
      desc: "toggle sidebar",
      group: "global",
    }),
    bind(
      "sidebar.toggle-agents-only",
      undefined,
      command("config.toggle", { name: "sidebar.agentsOnly" }),
      { desc: "show only panes running agent CLIs", group: "global" },
    ),
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
    if (chooseView()) {
      // The choose-buffer picker is its own modal: ↑↓ picks, enter pastes the
      // selection into the focused pane, d deletes it, escape closes. With no
      // buffers there is nothing to pick, so only escape does anything.
      const view = chooseView()!
      const count = view.buffers.length
      if (event.name === "j" || event.name === "down") {
        setChooseView((v) => (v ? { ...v, selected: Math.min(count - 1, v.selected + 1) } : v))
      } else if (event.name === "k" || event.name === "up") {
        setChooseView((v) => (v ? { ...v, selected: Math.max(0, v.selected - 1) } : v))
      } else if (event.name === "pagedown") {
        setChooseView((v) => (v ? { ...v, selected: Math.min(count - 1, v.selected + 10) } : v))
      } else if (event.name === "pageup") {
        setChooseView((v) => (v ? { ...v, selected: Math.max(0, v.selected - 10) } : v))
      } else if (event.name === "return" || event.name === "enter") {
        const name = view.buffers[view.selected]?.name
        if (name) view.onPaste(name)
      } else if (event.name === "d") {
        const name = view.buffers[view.selected]?.name
        if (name) view.onDelete(name)
      } else if (event.name === "escape") {
        view.onClose()
      }
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
    const fields = settingsFields(options(), settingsSection())
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
      case "right": {
        const option = selectedOption()
        if (option) adjustOption(option, event.name === "right" ? 1 : -1)
        return
      }
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

  function updateHintVisibility(sequence: readonly { display: string }[]) {
    clearHintTimer()
    setPendingParts(sequence)
    const visibility = hintVisibility(
      sequence.length,
      options()["appearance.whichKeyHints"],
      options()["appearance.whichKeyDelay"],
    )
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

  /**
   * Put the options into effect.
   *
   * Reactive rather than a callback fired at each place a setting is changed,
   * which is what it used to be: the settings window ran refreshChrome and
   * re-evaluated the which-key timer itself, so a change arriving from anywhere
   * else — a keybinding, the socket, a drag — reached the value but not the
   * screen. Anything that depends on an option belongs in here, where the
   * dependency is the option itself and not the act of editing it.
   */
  createEffect(() => {
    // Before the redraw: pane borders and wheel scrolling read these values
    // imperatively, from renderables with no path back into this graph.
    applyOptions(options())
    syncSidebarFrame()
  })

  // The keymap's own event covers the sequence changing; this covers the two
  // options that decide what to do with it.
  createEffect(
    on(
      () => [options()["appearance.whichKeyHints"], options()["appearance.whichKeyDelay"]],
      () => updateHintVisibility(pendingParts()),
    ),
  )

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
  // Initial status is the reconnect snapshot; later generations arrive on the
  // model stream. The client never invents a fallback workspace of its own.
  const initialWorkspace = session.workspace()
  run(projectWorkspace(spaces, initialWorkspace, session.backend()))
  projectedRevision = initialWorkspace.revision
  for (const space of spaces.spaces) {
    for (const window of space.windows) {
      window.onModelFocus = (pane) => runProjectedCommand(command("pane.select", { pane }))
      window.onModelResizeDivider = (path, index, delta) =>
        runProjectedCommand(command("pane.resize-divider", { path: [...path], index, delta }))
    }
  }
  syncSidebarFrame()
  void refreshGit()
  const gitTimer = setInterval(() => void refreshGit(), 5000)
  gitTimer.unref?.()
  const View = () => (
    <App
      app={app}
      options={options()}
      paneHost={paneHost}
      size={size()}
      sidebarHandle={sidebarHandle}
      selected={selected()}
      hovered={hovered()}
      onHover={setHovered}
      onActivate={activateSelection}
      pending={pending()}
      hints={hints()}
      hintsVisible={hintsVisible()}
      onSelectWindow={(w) => {
        const space = spaces.active
        if (space) runProjectedCommand(command("window.select", { space: space.id, number: w.number }))
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
      chooseView={chooseView()}
      copying={copying()}
    />
  )

  /**
   * Stop everything this function started.
   *
   * Deliberately NOT a detach: the spaces are left alone, because disposing an
   * agent kills its process. Only our own observers and timers go, and the
   * workspace is already durable in the daemon before its revision is published.
   */
  function dispose() {
    // While the pane is still alive: the mode's exit clears the selection
    // through the pane's terminal, and a freed terminal cannot be caught.
    if (copyMode.active) copyMode.exit()
    clearInterval(copyTimer)
    clearInterval(gitTimer)
    clearHintTimer()
    Effect.runFork(Fiber.interrupt(modelFiber))
    app.dispose()
  }

  return { View, dispose }
}
