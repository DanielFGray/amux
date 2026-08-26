/** @jsxImportSource @opentui/solid */
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { Show, createSignal, createMemo, createEffect, on } from "solid-js";
import { Effect, Exit, FiberMap, Scope, Stream } from "effect";
import { theme } from "./ui/theme.ts";
import { basename, dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { ProcessState } from "./process-state.ts";
import { SPINNER_FRAMES } from "./detect.ts";

import { projectWorkspace, SpaceSet } from "./space.ts";
import { frame } from "./window.ts";
import { LAYOUT_PRESETS, type LayoutPreset } from "./layout.ts";
import { TerminalPane } from "./pane.ts";
import { readGit } from "./git.ts";
import { sendKeys, type SendTarget } from "./send.ts";
import {
  createBindings,
  helpGroups,
  nextKeys,
  formatSequence,
  formatKey,
  leaderBytes,
  parseKeyStrokes,
  keysFor,
  DEFAULT_LEADER,
  type CommandSpec,
  type Conflict,
  type Keys,
  filterPaletteEntries,
  paletteEntries,
} from "./bindings.ts";
import {
  COMMAND_META,
  CommandError,
  command,
  makeCommands,
  runDetached,
  type Command,
  type Commands,
  type CommandHandlers,
  type CommandTag,
  type CommandResult,
  type RuntimeCommand,
} from "./commands.ts";
import { CONFIG_PATH, saveConfig, type Config } from "./config.ts";
import {
  adjustedValue,
  applyOptions,
  clearOption,
  coerceOption,
  optionSpec,
  resolveOptions,
  writeOption,
  type Options,
  type OptionSpec,
  type OptionValue,
} from "./options.ts";
import type { SessionClientContract } from "./client.ts";
import { workspaceSessions, type WorkspaceSnapshot } from "./workspace.ts";
import { createAppState, POLL_MS } from "./ui/state.ts";
import { createPanelContext, type PanelContext } from "./ui/panel.ts";
import { App } from "./ui/App.tsx";
import { createRegions, type Panel } from "./ui/regions.tsx";
import {
  createPluginContributions,
  type PluginContributions,
  type PluginInstance,
} from "./plugin/contributions.ts";
import { createPluginHost, type PluginHost } from "./plugin/host.ts";
import { loadPluginsFromConfig } from "./plugin/loader.ts";
import { createReloader } from "./plugin/reloader.ts";
import type { PluginReloader } from "./plugin/reloader.ts";
import { WindowTabs } from "./ui/WindowTabs.tsx";
import { formatText } from "./format.ts";
import { CommandPalette } from "./ui/CommandPalette.tsx";
import { Prompt, type PromptRequest } from "./ui/Prompt.tsx";
import { Hints, hintVisibility } from "./ui/Hints.tsx";
import {
  Settings,
  settingsSections,
  settingsFields,
  keybindTargets,
  keybindLine,
  type SettingsSection,
} from "./ui/Settings.tsx";
import { captureSpan, pickCaptureTarget, type CaptureSpan, type CaptureTarget } from "./capture.ts";
import { Capture, type CaptureView } from "./ui/Capture.tsx";
import { BufferChoose, type BufferChooseView } from "./ui/BufferChoose.tsx";
import { KeybindPicker, sortKeybindEntries, type KeybindPickerView } from "./ui/KeybindPicker.tsx";
import { CopyMode } from "./copy.ts";
import type { BufferEntry } from "./effect/BufferStore.ts";
import { scheduledPoll } from "./effect/timer.ts";
import { workspaceEnv } from "./env.ts";
import type { SidebarDisplayRow, SidebarDisplay } from "./ui/panel.ts";
import type { PluginSettingsSection, SpawnProvider } from "./plugin/types.ts";
import { createSessionViews } from "./plugin/session-views.tsx";
import { createProcessDisplay, type ProcessDisplay } from "./plugin/process-display.ts";
import { errorMessage } from "./error-message.ts";
import type { JsonValue } from "./effect/AttachProtocol.ts";

export interface AppOptions {
  readonly renderer: CliRenderer;
  /** The imperative half of the tree, created by the caller because the
   *  renderer owns it and the Effect program owns the renderer. */
  readonly paneHost: BoxRenderable;
  readonly config: Config;
  /** Directory containing the loaded config, used to resolve local plugins. */
  readonly configDir?: string;
  readonly session: SessionClientContract;
  /** Ask the program to exit. The app does not own the process, the renderer or
   *  the session, so leaving is a request rather than a teardown. */
  readonly quit: () => void;
}

export interface PluginRuntime {
  reloader?: PluginReloader;
  pathFor?: (id: string) => string | undefined;
  resumePending?: (workspace: WorkspaceSnapshot) => Effect.Effect<void>;
}

function setPluginEnabled(config: Config, path: string, enabled: boolean): Config {
  const index = config.plugins.findIndex((entry) => entry.path === path);
  if (index < 0) return { ...config, plugins: [...config.plugins, { path, enabled }] };
  const plugins = [...config.plugins];
  plugins[index] = { ...plugins[index]!, enabled };
  return { ...config, plugins };
}

export interface AppHandle {
  /** The Solid component the caller renders. A function, not a props object:
   *  the signals below are read inside it, and evaluating them any earlier
   *  would hand `render` a dead snapshot. */
  readonly View: () => JSX.Element;
  /** Value-only context available to in-process panels and plugins. */
  readonly panel: PanelContext;
  readonly pluginHost: PluginHost;
}

export function runCommandByTarget<A, B>(
  command: Command,
  workspace: () => Effect.Effect<A, CommandError>,
  session: () => Effect.Effect<B, CommandError>,
): Effect.Effect<A | B, CommandError> {
  return COMMAND_META[command._tag].target === "workspace" ? workspace() : session();
}

interface ManagedAppHandle extends Omit<AppHandle, "pluginHost"> {
  readonly release: Effect.Effect<void>;
  readonly commands: Commands;
  readonly registerBinding: (owner: PluginInstance, binding: CommandSpec) => () => void;
  readonly registerSettingsSection: (
    owner: PluginInstance,
    section: PluginSettingsSection,
  ) => () => void;
  readonly registerOption: (owner: PluginInstance, name: string, spec: OptionSpec) => () => void;
}

/**
 * Who the app's own panels and bindings belong to.
 *
 * They go through the same tables as a plugin's, so that a plugin claiming a
 * name the app already uses is refused by the same rule that stops two plugins
 * colliding. There is only ever one generation of it: the app does not reload.
 */
const CORE_CONTRIBUTOR: PluginInstance = { id: "amux", generation: 0 };

/** A synchronous launcher captured from the app's scoped FiberMap. */
export type AppFiberRunner = (key: string, effect: Effect.Effect<void>) => void;

/** The two modals that share one slot, because opening either closes the
 *  other: they are the same window in the user's head. */
export type Overlay = "none" | "settings" | "palette";

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
export function createApp(options: AppOptions): Effect.Effect<AppHandle, never, Scope.Scope> {
  const initialShell = [
    resolveOptions(options.config.options)["behaviour.shell"] || process.env.SHELL || "bash",
  ];
  return Effect.gen(function* () {
    const fiberScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(fiberScope, Exit.void));
    const fibers = yield* Scope.extend(FiberMap.make<string>(), fiberScope);
    const runFiber = yield* FiberMap.runtime(fibers)<never>();
    // A component pane's view sends what the user types through the app's
    // command pipeline, and the app is built from the workspace — so the
    // workspace cannot be handed a finished view. It is handed a call into
    // whichever one the app installs, the same deferred wiring as
    // window.onModelFocus, which is likewise attached after projection rather
    // than at construction.
    const contributions = createPluginContributions();
    const sessionViews = createSessionViews(contributions);
    const processDisplay = createProcessDisplay(contributions);
    const spaces = yield* SpaceSet.make(
      workspaceEnv(options.renderer, {
        shell: initialShell,
        backend: options.session.backend(),
        paneContent: sessionViews.view,
      }),
      options.paneHost,
    );
    const regions = createRegions(options.renderer, contributions);
    const spawnProviders = contributions.table<() => SpawnProvider>();
    const pluginRuntime: PluginRuntime = {};
    const app = yield* Effect.acquireRelease(
      Effect.sync(() =>
        buildApp(
          options,
          spaces,
          fiberScope,
          runFiber,
          regions,
          contributions,
          pluginRuntime,
          processDisplay,
        ),
      ),
      (app) => app.release,
    );
    const pluginHost = yield* createPluginHost({
      panel: app.panel,
      contributions,
      registries: {
        regions,
        sessionViews,
        processDisplay,
        bindings: app.registerBinding,
        settings: app.registerSettingsSection,
        options: app.registerOption,
        spawnProviders: (owner, id, provider) => spawnProviders.add(owner, id, provider),
        spawnProvider: (id) => spawnProviders.get(id)?.(),
        commands: (owner, registration) =>
          app.commands.registerCommand(
            owner.id,
            registration.verb,
            registration.fields,
            registration.meta,
            registration.handler,
          ),
      },
      frames: (id) => options.session.attach.stream(id),
      sync: (id) => options.session.attach.sync(id),
    });
    const hotPlugins = yield* loadPluginsFromConfig(
      options.config,
      pluginHost,
      options.configDir ?? dirname(CONFIG_PATH),
    );
    const resumedPending = new Set<string>();
    pluginRuntime.resumePending = (workspace) =>
      Effect.forEach(
        [...workspaceSessions(workspace)].filter(
          ({ session }) =>
            session.kind === "component" &&
            !session.exited &&
            session.provider &&
            !resumedPending.has(session.id),
        ),
        ({ session }) => {
          resumedPending.add(session.id);
          const provider = pluginHost.spawnProvider(session.provider!);
          return options.session
            .resumeAgent({
              session: session.id,
              provider: session.provider!,
              argv: provider?.argv,
              env: provider?.env,
              stripEnv: provider?.stripEnv,
            })
            .pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  app.panel.reportError(errorMessage(error));
                }),
              ),
            );
        },
        { discard: true },
      );
    yield* pluginRuntime.resumePending(options.session.workspace());
    // A plugin that dies on activation used to be silent outside the tests.
    runFiber(
      "plugin-errors",
      Stream.runForEach(pluginHost.onError, (event) =>
        Effect.sync(() => app.panel.reportError(`${event.pluginId}: ${event.error.message}`)),
      ),
    );
    // `plugin.reload` goes out through the daemon and comes back here, so a
    // client reloads whether the request was typed into it or into another one.
    const reloader = createReloader(pluginHost, hotPlugins);
    pluginRuntime.reloader = reloader;
    pluginRuntime.pathFor = (id) => hotPlugins.find((plugin) => plugin.id === id)?.path;
    runFiber(
      "plugin-reload",
      Stream.runForEach(options.session.events, (event) =>
        event._tag !== "plugins.reload"
          ? Effect.void
          : Effect.forEach(
              event.plugin === undefined ? reloader.reloadable() : [event.plugin],
              (id) =>
                reloader
                  .reload(id)
                  .pipe(
                    Effect.catchAll((message) => Effect.sync(() => app.panel.reportError(message))),
                  ),
              { discard: true },
            ),
      ),
    );
    // A CLI invocation of a plugin command has no registry of its own to run
    // it against — the daemon runs no plugins — so it lands here, on whichever
    // client the daemon picked, and gets executed against this client's own
    // `commands.run`, exactly as a keybinding would.
    runFiber(
      "command-requests",
      Stream.runForEach(options.session.commandRequests, ({ id, command: raw }) => {
        const tag = (raw as RuntimeCommand)._tag;
        // The daemon cannot know a plugin verb's `target` — it holds no
        // registry of its own — so a request reaching a client is where
        // "view commands never run remotely" actually gets enforced, using
        // the same check a core command's CLI invocation already goes through.
        if (!app.commands.isRemoteCommand(tag))
          return Effect.sync(() =>
            options.session.respondCommand(
              id,
              undefined,
              `command '${tag}' is a view command, not remotely invocable`,
            ),
          );
        return app.commands.run(raw as RuntimeCommand).pipe(
          Effect.map((result) =>
            options.session.respondCommand(id, (result as JsonValue | undefined) ?? undefined),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => options.session.respondCommand(id, undefined, errorMessage(error))),
          ),
        );
      }),
    );
    return { ...app, pluginHost };
  });
}

/** Replace the pending which-key delay inside the app's scoped fiber map. */
export function scheduleHintVisibility(
  runFiber: AppFiberRunner,
  delayMs: number,
  hasPendingSequence: () => boolean,
  show: () => void,
) {
  runFiber(
    "hint-delay",
    Effect.sleep(`${delayMs} millis`).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (hasPendingSequence()) show();
        }),
      ),
    ),
  );
}

/** Consume daemon models in stream order under the app's supervised fiber. */
export function runModelProjections<A>(
  models: Stream.Stream<A>,
  project: (model: A) => Promise<void>,
): Effect.Effect<void> {
  return Stream.runForEach(models, (model) => Effect.promise(() => project(model)));
}

function buildApp(
  { renderer, paneHost, config, session, quit }: AppOptions,
  spaces: SpaceSet,
  fiberScope: Scope.CloseableScope,
  runFiber: AppFiberRunner,
  regions: ReturnType<typeof createRegions>,
  contributions: PluginContributions,
  pluginRuntime: PluginRuntime,
  processDisplay: ProcessDisplay,
): ManagedAppHandle {
  const initialFrameExternalLeft = frame.externalLeft;
  contributions.commit(CORE_CONTRIBUTOR);

  /**
   * Run one of the workspace's Effect-returning methods here and now.
   *
   * Commands no longer need this — a CommandSpec's `run` is an Effect, so it
   * yields. What is left are the callers that are not commands and cannot be:
   * boot, and the prompt flows, which are `async` because they await an answer
   * from a Solid signal rather than from Effect.
   */
  const run = <A,>(effect: Effect.Effect<A>): A => Effect.runSync(effect);

  // Copy goes to the clipboard AND the server's buffer stack — tmux's model,
  // and what makes copy/paste work over ssh, between panes, and from a
  // script: the stack lives beside the daemon's PTYs, so paste needs no
  // attached client. The clipboard keeps its old verdict (a rejected OSC 52
  // is still a rejection); the push is best-effort and fire-and-forget, the
  // same as the clipboard write itself.
  spaces.onCopy = (text) => {
    void Effect.runPromise(session.setBuffer(undefined, text)).catch((error) =>
      console.error(`could not push paste buffer: ${String(error)}`),
    );
    return renderer.copyToClipboardOSC52(text);
  };
  spaces.onCopyError = (error) => console.error(error.message);
  const app = createAppState(spaces);
  const [snapshot, setSnapshot] = createSignal<WorkspaceSnapshot>(session.workspace());
  session.attach.onClose = () => setDaemonDisconnected(true);

  /**
   * Keyboard copy mode: the pane's read-only review layer. One instance for the
   * whole app, entered on whatever pane is focused. The mode renders through the
   * pane's existing selection machinery and copies through the same chain the
   * mouse drag does, so nothing here owns a second copy path.
   */
  const copyMode = new CopyMode();
  copyMode.onStateChange = () => app.refresh();
  // The search prompt reuses the app's modal prompt; resolve feeds the query back
  // into the mode. A blank query or a cancel leaves the search untouched.
  copyMode.onSearchRequest = (dir) => {
    setPromptError("");
    setPromptRequest({
      title: dir === "forward" ? "search forward" : "search backward",
      footer: "smartcase: case-insensitive unless the pattern has a capital",
      fields: [{ label: "pattern", placeholder: "text to find" }],
      resolve: (values) => {
        const query = values?.[0] ?? "";
        setPromptRequest(null);
        if (query) copyMode.search(query, dir);
      },
    });
  };
  // Output that lands while the mode rides the live bottom re-pins the cursor to
  // the newest row, so the highlight follows the screen instead of stranding in
  // history. A no-op whenever the mode is parked or inactive — and never allowed
  // to touch a pane that has left the tree: a tick landing between a structural
  // change and its notification must not invalidate a view being torn down.
  runFiber(
    "ui-poll",
    scheduledPoll(POLL_MS, () => {
      app.poll();
      const pane = copyMode.pane;
      if (!pane || paneStillMounted(pane)) copyMode.reconcile();
    }),
  );

  let projectedRevision = -1;
  let projection = Promise.resolve();
  let disposed = false;
  let runProjectedCommand: (value: Command) => void = () => {};
  const installModelCallbacks = () => {
    for (const space of spaces.spaces) {
      for (const window of space.windows) {
        window.onModelFocus = (pane) => runProjectedCommand(command("pane.select", { pane }));
        window.onModelResizeDivider = (path, index, delta) =>
          runProjectedCommand(command("pane.resize-divider", { path: [...path], index, delta }));
      }
    }
  };
  const project = (model: WorkspaceSnapshot): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (model.revision <= projectedRevision) return projection;
    projection = projection
      .then(() => {
        if (model.revision <= projectedRevision) return;
        return Effect.runPromise(projectWorkspace(spaces, model, session.backend()));
      })
      .then(() => {
        if (model.revision <= projectedRevision) return;
        projectedRevision = model.revision;
        setSnapshot(structuredClone(model));
        installModelCallbacks();
        app.refresh();
        if (model.spaces.length === 0) shutdown();
      })
      .catch((error) =>
        console.error(`could not project workspace revision ${model.revision}: ${String(error)}`),
      );
    return projection;
  };
  runFiber("workspace-models", runModelProjections(session.models, project));
  const workspaceContext = () => ({
    size: {
      cols: Math.max(1, paneHost.width),
      rows: Math.max(1, paneHost.height),
    },
    shell: [
      resolveOptions(configState().options)["behaviour.shell"] || process.env.SHELL || "bash",
    ],
    cwd: spaces.active?.dir ?? process.cwd(),
    blockedAgents: spaces.allSessions
      .filter((session) => session.state === ProcessState.Blocked)
      .map((session) => session.id),
  });

  const runPanelCommand = <T extends CommandTag>(
    value: Extract<Command, { _tag: T }>,
    input?: string,
  ): Effect.Effect<CommandResult<T>, CommandError> =>
    session
      .runWorkspace(value, {
        ...workspaceContext(),
        input,
      })
      .pipe(
        Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
        Effect.tap(({ snapshot }) => Effect.promise(() => project(snapshot))),
        Effect.tap(({ snapshot }) => pluginRuntime.resumePending?.(snapshot) ?? Effect.void),
        Effect.map(({ result }) => result as CommandResult<T>),
      );

  const runCommand = <T extends CommandTag>(
    value: Extract<Command, { _tag: T }>,
    input?: string,
  ): Effect.Effect<CommandResult<T>, CommandError> =>
    runCommandByTarget(
      value,
      () => runPanelCommand(value, input),
      () =>
        session.run(value).pipe(
          Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
          Effect.map((result) => result as CommandResult<T>),
        ),
    );

  const [configState, setConfigState] = createSignal<Config>(config);
  /** Every core option resolved against its declared default — what the app
   *  reads for its own chrome. The config itself holds only what the user
   *  changed. Plugin-registered options are not in here: they have no fixed
   *  key set to iterate, so they are resolved on demand by name instead. */
  const options = createMemo(() => resolveOptions(configState().options));

  /** Names a plugin has claimed through `registerOption`, section-sorted and
   *  rendered by the settings window the same way a core option is. */
  const optionContributions = contributions.table<OptionSpec>();

  /** A core or plugin-registered option's declaration, by name. */
  function specFor(name: string): OptionSpec | undefined {
    return optionSpec(name) ?? optionContributions.get(name);
  }

  /** A core or plugin-registered option's current value, resolved the same
   *  way the core `options` memo resolves one — default unless the config has
   *  a delta for it. */
  function optionValue(name: string, spec: OptionSpec): OptionValue {
    return coerceOption(spec, configState().options[name]) ?? spec.default;
  }

  /**
   * Put a new value into an option, core or plugin-registered.
   *
   * The one path for any change: a key, the settings window, a drag, the socket.
   * The clamping and the default-is-not-stored rule live in the table, so this
   * only decides what the change means for the screen — unsaved, and the last
   * save's error no longer describes what is on it.
   */
  function changeOption(name: string, value: OptionValue) {
    const spec = specFor(name);
    if (!spec) return;
    setConfigState((c) => ({
      ...c,
      options: writeOption(c.options, name, spec, value),
    }));
    setSettingsError("");
    setSettingsDirty(true);
  }

  /** Move an option relative to where it is: ←/→ in settings, and the drag. */
  function adjustOption(name: string, by: number) {
    const spec = specFor(name);
    if (!spec) return;
    changeOption(name, adjustedValue(spec, optionValue(name, spec), by));
  }

  /** Where every panel on screen is registered. See registerPanels below. */

  const [overlay, setOverlay] = createSignal<Overlay>("none");
  // The raw compiled parts, not a formatted string: the which-key panel has to
  // match them against every binding's sequence to work out what is still
  // reachable, and a display string cannot be matched back.
  const [pendingParts, setPendingParts] = createSignal<readonly { display: string }[]>([]);
  const [hintsVisible, setHintsVisible] = createSignal(false);
  const [promptRequest, setPromptRequest] = createSignal<PromptRequest | null>(null);
  /** Compile error from the send-keys prompt's last submit. Kept separate from
   *  the request so a reject does not recreate it and wipe the user's input. */
  const [promptError, setPromptError] = createSignal<string>("");
  const [captureView, setCaptureView] = createSignal<CaptureView | null>(null);
  /** The choose-buffer overlay, when it is up. */
  const [chooseView, setChooseView] = createSignal<BufferChooseView | null>(null);
  const [settingsSection, setSettingsSection] = createSignal<SettingsSection>("sidebar");
  const [settingsSelected, setSettingsSelected] = createSignal(0);
  /** Which of the settings window's two lists has the keyboard, or whether the
   *  selected item is being edited. Left/Tab step back a level; Right/Enter
   *  step forward; only Escape from "editing" undoes the value in progress. */
  const [settingsFocus, setSettingsFocus] = createSignal<"sections" | "items" | "editing">("items");
  /** The value an item held before editing began, so Escape can put it back. */
  const [editOriginal, setEditOriginal] = createSignal<OptionValue | null>(null);
  /** A number field's own typed buffer — see `Settings`'s `editText` prop for
   *  why a number can't just show its coerced option value while typed. */
  const [editText, setEditText] = createSignal<string | undefined>(undefined);
  const [settingsDirty, setSettingsDirty] = createSignal(false);
  const [settingsError, setSettingsError] = createSignal("");
  const settingsSectionTable = contributions.table<PluginSettingsSection>();
  const pluginSettings = () => settingsSectionTable.all().map((entry) => entry.value);
  /** True while the keybind editor is waiting for the keystroke to record. */
  const [capturing, setCapturing] = createSignal(false);
  const [conflicts, setConflicts] = createSignal<Conflict[]>([]);
  const [keybindPicker, setKeybindPicker] = createSignal<KeybindPickerView | null>(null);
  const [paletteQuery, setPaletteQuery] = createSignal("");
  const [paletteSelected, setPaletteSelected] = createSignal(0);
  /** The keybind tab's scroll container, so ↑↓ can drive a list that is much
   *  longer than the window. */
  let keybindList: ScrollBoxRenderable | null = null;
  const [commandError, setCommandError] = createSignal<string | null>(null);
  function showCommandError(message: string) {
    setCommandError(message);
    setTimeout(() => setCommandError(null), 3000);
  }
  const [daemonDisconnected, setDaemonDisconnected] = createSignal(false);
  const [selectedAgentId, setSelectedAgentId] = createSignal<string | null>(null);
  const [size, setSize] = createSignal({
    width: renderer.width,
    height: renderer.height,
  });

  const display = createMemo<SidebarDisplay>(() => {
    app.tick();
    const rows: SidebarDisplayRow[] = [];
    let index = 0;
    const active = spaces.active;
    const activeWin = spaces.activeWindow;
    const focusedSession = activeWin?.focused?.session ?? null;

    for (const [spaceIndex, space] of spaces.spaces.entries()) {
      const isActiveSpace = space === active;
      rows.push({
        kind: "space",
        index: index++,
        spaceId: space.id,
        spaceName: space.name,
        spaceIndex,
        active: isActiveSpace,
      });

      if (space.branch) {
        rows.push({
          kind: "branch",
          index,
          spaceId: space.id,
          spaceName: space.name,
          spaceIndex,
          active: isActiveSpace,
          branch: space.branch,
          ahead: space.ahead,
          behind: space.behind,
        });
      }

      for (const window of space.windows) {
        const isActiveWindow = isActiveSpace && space.active === window;
        rows.push({
          kind: "window",
          index: index++,
          spaceId: space.id,
          spaceName: space.name,
          spaceIndex,
          active: isActiveWindow,
          windowNumber: window.number,
          windowLabel: window.label,
        });

        for (const [paneIndex, session] of window.sessions.entries()) {
          const isFocusedAgent = isActiveWindow && session === focusedSession;
          rows.push({
            kind: "agent",
            index: index++,
            spaceId: space.id,
            spaceName: space.name,
            spaceIndex,
            active: isFocusedAgent,
            windowNumber: window.number,
            paneIndex,
            windowLabel: window.label,
            agentId: session.id,
            agentState: session.state,
            exitCode: session.exitCode,
            detached: session.detached,
            agentCliKind: session.agentKind,
            agentSessionKind: session.kind,
            title: session.title,
            foregroundCommand: session.foregroundCommand,
            viewers: session.viewers,
            unseen: session.unseen,
            scrolled: session.scrolled,
            exited: session.exited,
          });
        }
      }
    }

    const allSessions = spaces.allSessions.filter((session) => !session.exited);
    const blocked = allSessions.filter((session) => session.state === ProcessState.Blocked).length;

    return {
      rows,
      spaceCount: spaces.spaces.length,
      agentCount: allSessions.length,
      blockedCount: blocked,
    };
  });
  const onResize = (width: number, height: number) => setSize({ width, height });
  renderer.on("resize", onResize);

  const activeWin = () => spaces.activeWindow;

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
      setPromptError("");
      setPromptRequest({
        title,
        fields,
        resolve: (values) => {
          setPromptRequest(null);
          resume(Effect.succeed(values));
        },
      });
      // Interrupting the binding takes the prompt down with it rather than
      // leaving a modal nobody is waiting on.
      return Effect.sync(() => setPromptRequest(null));
    });
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
    const cwd = spaces.active?.dir ?? process.cwd();
    const answers = yield* ask("New space", [
      { label: "Name", value: basename(cwd), placeholder: "space name" },
      { label: "Branch (worktree)", value: "", placeholder: "branch name" },
      { label: "Directory", value: cwd, placeholder: "path" },
    ]);
    if (!answers) return;
    const args: Record<string, string> = {};
    if (answers[0]) args.name = answers[0];
    const branch = answers[1]?.trim();
    if (branch) {
      args.branch = branch;
    } else {
      args.dir = answers[2] || cwd;
    }
    yield* commands.run(command("space.new", args));
  });

  const promptRenameSpace = Effect.gen(function* () {
    const space = spaces.active;
    if (!space) return;
    const answers = yield* ask("Rename space", [{ label: "Name", value: space.name }]);
    if (!answers) return;
    yield* commands.run(command("space.rename", { space: space.id, name: answers[0] ?? "" }));
  });

  const promptMovePane = Effect.gen(function* () {
    const current = spaces.active;
    const candidates = spaces.spaces.filter((space) => space !== current);
    if (!candidates.length) return;
    const answers = yield* ask("Move pane to space", [
      {
        label: "Space",
        value: candidates[0]!.name,
        placeholder: candidates.map((space) => space.name).join(", "),
      },
    ]);
    if (!answers) return;
    const wanted = candidates.find(
      (space) => space.id === answers[0] || space.name === answers[0]?.trim(),
    );
    if (!wanted) return yield* new CommandError({ message: "unknown target space" });
    yield* commands.run(command("pane.move", { space: wanted.id }));
  });

  const promptRenameWindow = Effect.gen(function* () {
    const space = spaces.active;
    const window = space?.active;
    if (!space || !window) return;
    const answers = yield* ask("Rename window", [
      {
        label: "Name",
        value: window.customName ?? "",
        placeholder: window.title,
      },
    ]);
    if (!answers) return;
    // Named rather than left implicit: the answer arrives whenever the user
    // finishes typing, and "the active window" may have moved by then.
    yield* commands.run(
      command("window.rename", {
        space: space.id,
        window: window.number,
        name: answers[0] ?? "",
      }),
    );
  });

  /**
   * Redraw the pane frame under the current docks.
   *
   * No dock draws the frame's edges any more: a dock's resize handle is an
   * invisible hitbox over its own last column, so the panes own all four of
   * their borders whatever is docked beside them.
   */
  function syncPaneFrame() {
    frame.externalLeft = false;
    spaces.refreshChrome();
  }

  // Appended to the app state's own handler rather than replacing it: focus moves
  // are structural changes, and this is the only notification of one.
  const notifyChange = spaces.onChange;
  spaces.onChange = () => {
    notifyChange?.();
    // A pane closing is a structural change; if it was the copy-mode pane, the
    // mode must step down rather than keep a handle on a destroyed view. Guarded
    // on the mode being active, since this runs on every output chunk.
    //
    // This is the only place the mode steps down for a closed pane: the client
    // never tears a pane down itself — the daemon owns the model, and the pane
    // disappears here, when this client projects the new revision. Exiting is
    // safe at this point because a closed pane's terminal survives (only its
    // renderable is destroyed), so clearing the selection cannot hit freed
    // memory.
    const copyPane = copyMode.active ? copyMode.pane : null;
    if (copyPane && !paneStillMounted(copyPane)) copyMode.exit();
  };

  /** Whether a pane still has a viewport anywhere, for the copy-mode orphan
   *  check above. Pane views close without ending their agent, so the terminal
   *  survives — but refresh() on a destroyed renderable does not. */
  function paneStillMounted(pane: TerminalPane): boolean {
    return spaces.spaces.some((s) => s.windows.some((w) => w.panes.includes(pane)));
  }

  /** The option the settings window's selection is sitting on, if any. */
  function selectedOption(): string | undefined {
    return settingsFields(allOptions(), settingsSection(), optionContributions.all())[
      settingsSelected()
    ]?.name;
  }

  /**
   * Put a new set of keys into effect.
   *
   * One path for every change — the prefix, a rebind, a reset — because the
   * keymap has to be rebuilt for any of them and the conflict report is only
   * true for the set that was actually applied.
   */
  function setKeys(next: Keys) {
    setConfigState((c) => ({ ...c, keys: next }));
    setSettingsError("");
    setConflicts(bindings.apply(next));
    setSettingsDirty(true);
  }

  /** The command a keybind row edits, or null for the prefix row. */
  function keybindTarget(index = settingsSelected()): string | null | undefined {
    return keybindTargets(groups())[index];
  }

  function availableKeyHints(): string[] {
    const active = bindings.keymap.getCommandBindings({
      visibility: "registered",
      commands: registeredBindings().map((command) => command.name),
    });
    const used = new Set(
      [...active.values()].flatMap((list) =>
        list.map((binding) => formatSequence(binding.sequence, bindings.leader())),
      ),
    );
    return [
      ..."abcdefghijklmnopqrstuvwxyz".split(""),
      ..."0123456789".split(""),
      "space",
      "tab",
      "left",
      "down",
      "up",
      "right",
    ].filter((key) => !used.has(`${formatKey(bindings.leader())} ${key}`));
  }

  function openKeybindPicker(add: boolean) {
    const target = keybindTarget();
    const entries = sortKeybindEntries(filterPaletteEntries(allPaletteEntries(), ""));
    const found = target ? entries.findIndex((entry) => entry.name === target) : 0;
    setKeybindPicker({
      entries,
      query: "",
      selected: Math.max(0, found),
      add,
      capturing: false,
      error: "",
      available: availableKeyHints(),
    });
  }

  function capturePrefix() {
    setCapturing(true);
    bindings.capture((event, key) => {
      setCapturing(false);
      if (event.name !== "escape") setKeys({ ...configState().keys, leader: key });
    });
  }

  /** Record the next keystroke for the selected action. */
  function captureBinding(command: string, add: boolean) {
    setCapturing(true);
    setKeybindPicker((view) => (view ? { ...view, capturing: true, error: "" } : view));
    bindings.capture((event, key) => {
      setCapturing(false);
      // Escape backs out — a binding on escape would swallow the one key every
      // overlay in the app relies on.
      if (event.name === "escape") {
        setKeybindPicker((view) => (view ? { ...view, capturing: false } : view));
        return;
      }
      const keys = configState().keys;
      const spec = registeredBindings().find((candidate) => candidate.name === command);
      if (!spec) return;
      const next = `<leader>${key}`;
      const compiled = bindings.keymap.parseKeySequence(next);
      const display = formatSequence(compiled, bindings.leader());
      const active = bindings.keymap.getCommandBindings({
        visibility: "registered",
        commands: registeredBindings().map((candidate) => candidate.name),
      });
      const owner = [...active].find(([, list]) =>
        list.some((binding) => formatSequence(binding.sequence, bindings.leader()) === display),
      )?.[0];
      if (owner && (add || owner !== command)) {
        setKeybindPicker((view) =>
          view
            ? {
                ...view,
                capturing: false,
                error: `${display} is already used by ${owner}`,
              }
            : view,
        );
        return;
      }
      const current = add ? keysFor(spec, keys) : [];
      setKeys({
        ...keys,
        bindings: {
          ...keys.bindings,
          [command]: current.includes(next) ? current : [...current, next],
        },
      });
      setKeybindPicker(null);
    });
  }

  /** Back to what the command shipped with, or to nothing at all. */
  function resetBinding(unbind: boolean) {
    const command = keybindTarget();
    const keys = configState().keys;
    if (command === undefined) return;
    if (command === null) {
      if (unbind) return; // The app is unreachable without a prefix.
      return setKeys({ ...keys, leader: DEFAULT_LEADER });
    }
    const next = { ...keys.bindings };
    if (unbind) next[command] = [];
    else delete next[command];
    setKeys({ ...keys, bindings: next });
  }

  /**
   * Enter keyboard copy mode on the focused pane.
   *
   * The mode reads only — it scrolls the viewport and drives the terminal's
   * selection highlight, and never writes a byte to the child, so the process
   * keeps running and its output stays live underneath the review.
   */
  function enterCopyMode() {
    const pane = spaces.activeWindow?.focused;
    // Copy mode reviews a terminal's grid and scrollback. A component pane has
    // neither — its content is renderables, not cells — so there is nothing for
    // the mode to walk and the key simply does nothing there.
    if (!(pane instanceof TerminalPane)) return;
    copyMode.enter(pane);
  }

  /**
   * A capture command's target: the focused pane, else the sidebar's selected
   * agent. Capture only reads a terminal, so — unlike send-keys — the selected
   * agent needs no viewport: a detached agent is captured as it is, without
   * being revealed or otherwise touched.
   */
  function captureTarget(): CaptureTarget | null {
    const focused = spaces.activeWindow?.focused?.session ?? null;
    return pickCaptureTarget(
      focused ? { term: focused.term, describe: () => focused.title || "pane" } : null,
      null,
    );
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
    const target = captureTarget();
    if (!target) {
      setPromptError("");
      setPromptRequest({
        title: "capture",
        notice: "no pane to capture",
        fields: [],
        resolve: () => setPromptRequest(null),
      });
      return;
    }
    const dir = spaces.active?.dir ?? process.cwd();
    const name = target.describe().replace(/[^\w.-]+/g, "-") || "pane";
    const path = join(dir, `capture-${name}-${Date.now()}.txt`);
    const open = (span: CaptureSpan) => {
      const content = captureSpan(target.term, span);
      setCaptureView({
        title: `captured pane: ${target.describe()}`,
        content,
        path,
        span,
        saved: false,
        onToggleSpan: () => open(span === "scrollback" ? "visible" : "scrollback"),
        onSave: () => {
          void writeFile(path, content)
            .then(() =>
              setCaptureView((view) => (view ? { ...view, saved: true, error: undefined } : view)),
            )
            .catch((error) => {
              setCaptureView((view) =>
                view
                  ? {
                      ...view,
                      error: `could not save capture to ${path}: ${error instanceof Error ? error.message : String(error)}`,
                    }
                  : view,
              );
            });
        },
        onClose: () => setCaptureView(null),
      });
    };
    open("visible");
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
        const pane = spaces.activeWindow?.focused;
        if (pane?.session) {
          void Effect.runPromise(session.pasteBuffer(name, pane.session.id)).catch((error) =>
            console.error(`could not paste buffer '${name}': ${String(error)}`),
          );
        }
        setChooseView(null);
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
            );
          })
          .catch((error) => console.error(`could not delete buffer '${name}': ${String(error)}`));
      },
      onClose: () => setChooseView(null),
    });
  }

  /**
   * The pane send-keys targets: the focused pane, or the sidebar's selected
   * agent when nothing is focused. Selected agents are revealed first — a row is
   * only a "selected pane" once it has a viewport keystrokes can land in.
   */
  function sendKeysTarget(): SendTarget | null {
    const focused = spaces.activeWindow?.focused ?? null;
    if (focused) return { write() {}, describe: () => focused.session?.title || "pane" };
    return null;
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
    const target = sendKeysTarget();
    if (!target) {
      setPromptError("");
      setPromptRequest({
        title: "send-keys",
        notice: "no pane to send to",
        fields: [],
        resolve: () => setPromptRequest(null),
      });
      return;
    }
    setPromptError("");
    setPromptRequest({
      title: `send-keys → ${target.describe()}`,
      footer: "keys: Enter, Escape, ctrl+a, space · text: 'ls -la' Enter · esc cancel",
      fields: [{ label: "keys", placeholder: "e.g. 'ls -la' Enter" }],
      // Not `ask`: a rejected input keeps this prompt open with the reason in
      // it, so the resolver has to see the command's failure rather than close
      // over the answer. Cancelling closes — escape used to be answered with
      // "nothing to send", which read as a rejection of a value nobody typed.
      resolve: (values) => {
        if (values === null) return setPromptRequest(null);
        runDetached(
          "pane.send-keys",
          commands.run(command("pane.send-keys", { keys: values[0] ?? "" })),
          showCommandError,
        );
        setPromptRequest(null);
      },
    });
  });

  /** The declaration behind an option name, core or plugin-registered, or a
   *  refusal naming it. */
  function knownOption(
    name: string,
  ): Effect.Effect<{ spec: OptionSpec; option: string }, CommandError> {
    const spec = specFor(name);
    if (!spec) return Effect.fail(new CommandError({ message: `no option '${name}'` }));
    return Effect.succeed({ spec, option: name });
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
    "pane.split": runCommand,
    "pane.next": runCommand,
    "pane.last": runCommand,
    "pane.focus": runCommand,
    "pane.select": runCommand,
    "pane.resize": runCommand,
    "pane.resize-divider": runCommand,
    "pane.zoom": runCommand,
    "pane.float": runCommand,
    "pane.dock-left": runCommand,
    "pane.dock-right": runCommand,
    "pane.dock-top": runCommand,
    "pane.dock-bottom": runCommand,
    "pane.undock": runCommand,
    "pane.swap": runCommand,
    "pane.close": runCommand,
    "pane.break": runCommand,
    "pane.join": runCommand,
    "pane.move": runCommand,
    "pane.send-keys": ({ keys }) =>
      Effect.suspend(() => {
        let input = "";
        const error = sendKeys(
          {
            write: (bytes) => {
              input += bytes;
            },
            describe: () => "pane",
          },
          keys,
          parseKeyStrokes.bind(null, bindings.keymap),
        );
        return error
          ? Effect.fail(new CommandError({ message: error.message }))
          : runPanelCommand(command("pane.send-keys", { keys }), input);
      }),
    "pane.capture": () =>
      Effect.sync(() => {
        openCapture();
        return "";
      }),
    "pane.list": runCommand,
    "pane.current": runCommand,
    "pane.layout": runCommand,
    "pane.copy-mode": () =>
      Effect.sync(() => {
        enterCopyMode();
        return undefined as void;
      }),

    // The tmux paste-buffer family. The stack lives on the daemon; these
    // handlers are the local doors to it — the same RPC a script uses, minus
    // the parts that need a screen (the focused pane, the picker overlay).
    // The session methods fail with whatever the socket threw, so the message
    // is pulled out before it becomes a CommandError.
    "buffer.set": ({ name, data }) =>
      session
        .setBuffer(name, data)
        .pipe(Effect.mapError((error) => new CommandError({ message: errorMessage(error) }))),
    "buffer.paste": ({ name }) =>
      Effect.gen(function* () {
        const pane = spaces.activeWindow?.focused;
        if (!pane?.session) return yield* new CommandError({ message: "no pane to paste into" });
        yield* session
          .pasteBuffer(name, pane.session.id)
          .pipe(Effect.mapError((error) => new CommandError({ message: errorMessage(error) })));
      }),
    "buffer.list": () =>
      session.listBuffers().pipe(
        Effect.map((bufs) =>
          bufs.map((b) => ({
            name: b.name,
            bytes: b.bytes,
            preview: b.preview,
          })),
        ),
        Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
      ),
    "buffer.delete": ({ name }) =>
      session
        .deleteBuffer(name)
        .pipe(Effect.mapError((error) => new CommandError({ message: errorMessage(error) }))),
    "buffer.show": ({ name }) =>
      session
        .showBuffer(name)
        .pipe(Effect.mapError((error) => new CommandError({ message: errorMessage(error) }))),
    "buffer.choose": () =>
      Effect.gen(function* () {
        const buffers = yield* session
          .listBuffers()
          .pipe(Effect.mapError((error) => new CommandError({ message: errorMessage(error) })));
        openChooseBuffer(buffers);
      }),

    "window.new": runCommand,
    "window.next": runCommand,
    "window.previous": runCommand,
    "window.last": runCommand,
    "window.select": runCommand,
    "window.rename": runCommand,
    "window.close": runCommand,
    "window.next-layout": runCommand,
    "window.select-layout": runCommand,
    "window.synchronize-panes": runCommand,
    "window.list": runCommand,

    "agent.new": runCommand,
    "agent.prompt": runCommand,
    "agent.watch": runCommand,
    "agent.interrupt": runCommand,
    "agent.permission": runCommand,
    "agent.list": runCommand,
    "agent.get": runCommand,
    notify: runCommand,
    "session.kill": runCommand,
    "session.restart": runCommand,
    "session.reveal": runCommand,
    "session.next-blocked": runCommand,

    "space.new": runCommand,
    "space.select": runCommand,
    "space.rename": runCommand,
    "space.close": runCommand,
    "space.next": runCommand,
    "space.previous": runCommand,
    "space.list": runCommand,

    // The name arrives as a string from every surface, so it is checked here
    // rather than trusted: the table is what says whether it exists and what it
    // will accept, and a refusal is a value the caller can show.
    "config.set": ({ name, value }) =>
      Effect.gen(function* () {
        const { spec, option } = yield* knownOption(name);
        const coerced = coerceOption(spec, value);
        if (coerced === undefined) {
          return yield* new CommandError({
            message: `${name} does not take ${JSON.stringify(value)}`,
          });
        }
        changeOption(option, coerced);
      }),
    "config.toggle": ({ name }) =>
      Effect.gen(function* () {
        const { spec, option } = yield* knownOption(name);
        if (spec.kind !== "boolean") {
          return yield* new CommandError({
            message: `${name} is not a yes/no option`,
          });
        }
        changeOption(option, !optionValue(option, spec));
      }),
    "config.adjust": ({ name, by }) =>
      Effect.gen(function* () {
        const { option } = yield* knownOption(name);
        adjustOption(option, by);
      }),
    "config.reset": ({ name }) =>
      Effect.gen(function* () {
        const { option } = yield* knownOption(name);
        setConfigState((c) => ({
          ...c,
          options: clearOption(c.options, option),
        }));
        setSettingsError("");
        setSettingsDirty(true);
      }),
    "app.help": () =>
      Effect.sync(() => {
        // The same window as settings, on its keybinds tab. Two overlays
        // rendering the same list from the same data was one overlay too many
        // to teach.
        if (overlay() === "settings" && settingsSection() === "keybinds") return setOverlay("none");
        setSettingsSection("keybinds");
        setSettingsSelected(0);
        setSettingsFocus("items");
        setOverlay("settings");
      }),
    "app.command-palette": () =>
      Effect.sync(() => {
        setPaletteQuery("");
        setPaletteSelected(0);
        setOverlay("palette");
      }),
    "app.settings": () =>
      Effect.sync(() => {
        if (overlay() === "settings") return setOverlay("none");
        // Opening settings should land on settings, not on wherever ^a ? left
        // the tab last time.
        if (settingsSection() === "keybinds") setSettingsSection("sidebar");
        setSettingsSelected(0);
        setSettingsFocus("items");
        setOverlay("settings");
      }),
    "app.send-prefix": () =>
      Effect.sync(() => {
        const bytes = leaderBytes(bindings.leader());
        if (bytes) activeWin()?.write(bytes);
      }),
    // Through the daemon and back, so that every client attached to this
    // workspace reloads — including the one the agent is not looking at.
    "plugin.reload": (value) =>
      session.run(value).pipe(
        Effect.asVoid,
        Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
      ),
    "plugin.enable": ({ plugin }) =>
      Effect.suspend(
        () =>
          pluginRuntime.reloader?.enable(plugin) ?? Effect.fail("plugin runtime is unavailable"),
      ).pipe(
        Effect.tap(() =>
          Effect.promise(async () => {
            const path = pluginRuntime.pathFor?.(plugin) ?? plugin;
            const next = setPluginEnabled(configState(), path, true);
            setConfigState(next);
            await saveConfig(next);
          }),
        ),
        Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
      ),
    "plugin.disable": ({ plugin }) =>
      Effect.suspend(
        () =>
          pluginRuntime.reloader?.disable(plugin) ?? Effect.fail("plugin runtime is unavailable"),
      ).pipe(
        Effect.tap(() =>
          Effect.promise(async () => {
            const path = pluginRuntime.pathFor?.(plugin) ?? plugin;
            const next = setPluginEnabled(configState(), path, false);
            setConfigState(next);
            await saveConfig(next);
          }),
        ),
        Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
      ),
    "app.quit": () => Effect.sync(shutdown),
  };

  const commands = makeCommands(handlers);
  runProjectedCommand = (value) => runDetached(value._tag, commands.run(value), showCommandError);

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
    opts: {
      desc?: string;
      group?: string;
      hidden?: boolean;
      fixed?: boolean;
    } = {},
  ): CommandSpec {
    const meta = COMMAND_META[cmd._tag]!;
    return {
      name,
      key,
      desc: opts.desc ?? meta.desc,
      group: opts.group ?? meta.group,
      hidden: opts.hidden,
      fixed: opts.fixed,
      run: commands.run(cmd),
    };
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
    const meta = COMMAND_META[tag]!;
    return {
      name: tag,
      key,
      desc: desc ?? meta.desc,
      group: meta.group,
      run: open,
    };
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
    bind("pane.last", "<leader>;", command("pane.last"), {
      desc: "toggle to the last-focused pane",
    }),
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
      bind(`pane.resize-${direction}`, `<leader>${key}`, command("pane.resize", { direction }), {
        desc: `resize pane ${direction}`,
      }),
    ),
    bind("pane.zoom", "<leader>z", command("pane.zoom"), {
      desc: "zoom the focused pane (Z in the tab)",
    }),
    bind("pane.float", "<leader>f", command("pane.float"), {
      desc: "float the focused pane over the others, or put it back",
    }),
    bind("pane.dock-left", undefined, command("pane.dock-left")),
    bind("pane.dock-right", undefined, command("pane.dock-right")),
    bind("pane.dock-top", undefined, command("pane.dock-top")),
    bind("pane.dock-bottom", undefined, command("pane.dock-bottom")),
    bind("pane.undock", undefined, command("pane.undock")),
    bind("pane.swap-previous", "<leader>{", command("pane.swap", { to: "previous" }), {
      desc: "swap pane with the previous one",
    }),
    bind("pane.swap-next", "<leader>}", command("pane.swap", { to: "next" }), {
      desc: "swap pane with the next one",
    }),
    bind("pane.close", "<leader>x", command("pane.close"), {
      desc: "close pane (stops its backend if it has no other view)",
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
    bindPrompt("pane.move", "<leader>shift+m", promptMovePane, "move pane to another space"),

    // Windows.
    bind("window.new", "<leader>c", command("window.new")),
    bind("window.next", "<leader>n", command("window.next")),
    bind("window.previous", "<leader>p", command("window.previous")),
    // tmux's last-window, on tmux's own binding — which is also why focus-right
    // no longer answers to ^a l.
    bind("window.last", "<leader>l", command("window.last"), {
      desc: "toggle to the last window",
    }),
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
      bind(
        `window.select-${i + 1}`,
        `<leader>${i + 1}`,
        command("window.select", { number: i + 1 }),
        {
          desc: i === 0 ? "select window 1..9" : `select window ${i + 1}`,
          // Listed once, on the first; see CommandSpec.hidden for why this is a
          // flag and not an empty description.
          hidden: i > 0,
        },
      ),
    ),

    // Agent-aware session controls remain core. Launch policy is contributed by
    // each harness plugin through the scoped binding registry.
    // shift+k: plain ^a k is directional pane focus, and killing an agent is not
    // something to put one keystroke away from "move up" anyway.
    bind("session.kill", "<leader>shift+k", command("session.kill"), {
      desc: "stop the focused agent",
    }),
    bind("session.restart", "<leader>shift+r", command("session.restart"), {
      desc: "restart the focused agent",
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
    bind("app.send-prefix", "<leader><leader>", command("app.send-prefix"), {
      fixed: true,
    }),
    bind("app.quit", "<leader>q", command("app.quit")),
  ];

  /**
   * Keys not claimed by a binding belong to the child — except while a modal or
   * the sidebar has focus. Returns whether the app consumed the key; see the
   * note on preventDefault in bindings.ts.
   */
  function onUnhandled(event: KeyEvent): boolean {
    // Whatever modal is on top owns the keys the keymap did not claim. Each
    // overlay panel carries its own key handling, so there is no chain here and
    // no priority order written twice: the panel drawn last is the panel asked
    // first, both from its `order`.
    const modal = regions.topOverlay();
    if (modal) return modal.keys?.(event) ?? true;
    // Copy mode owns the focused pane's unhandled keys. Bound keys never reach
    // here, so the leader and every ^a sequence keep their normal meaning — and
    // a pane that is not in copy mode still gets its child's keystrokes, which
    // is how copy mode survives a ^a pane-focus away from it.
    if (copyMode.active && copyMode.pane === spaces.activeWindow?.focused) {
      return copyMode.onKey(event);
    }
    // The pane decides what an unbound key means, because that depends on what
    // fills it: a terminal wants the bytes a child would have read, a component
    // wants the event left alone for the renderable holding focus inside it.
    return activeWin()?.key(event) ?? false;
  }

  function paletteKey(event: KeyEvent) {
    const count = filteredPalette().length;
    switch (event.name) {
      case "up":
        if (count) setPaletteSelected((s) => Math.max(0, s - 1));
        return true;
      case "down":
        if (count) setPaletteSelected((s) => Math.min(count - 1, s + 1));
        return true;
      case "pageup":
        if (count) setPaletteSelected((s) => Math.max(0, s - 10));
        return true;
      case "pagedown":
        if (count) setPaletteSelected((s) => Math.min(count - 1, s + 10));
        return true;
    }
    // Let text and Enter reach the focused input renderable.
    return false;
  }

  function cycleSettingsSection(step: 1 | -1) {
    const sections = settingsSections(pluginSettings(), optionContributions.all());
    const i = sections.indexOf(settingsSection());
    setSettingsSection(sections[(i + step + sections.length) % sections.length]!);
    setSettingsSelected(0);
  }

  /** Move the keybind selection and keep it on screen. */
  function moveKeybind(delta: number) {
    const count = keybindTargets(groups()).length;
    const index = Math.max(0, Math.min(count - 1, settingsSelected() + delta));
    setSettingsSelected(index);
    const box = keybindList;
    if (!box) return;
    // The list is several screens long, so follow the selection rather than
    // leaving it to be moved off the top of a window it cannot scroll itself.
    const line = keybindLine(groups(), index);
    const height = box.viewport?.height ?? box.height;
    if (line < box.scrollTop) box.scrollTop = line;
    else if (line >= box.scrollTop + height) box.scrollTop = line - height + 1;
  }

  function keybindsKey(event: KeyEvent) {
    switch (event.name) {
      case "j":
      case "down":
        return moveKeybind(1);
      case "k":
      case "up":
        return moveKeybind(-1);
      case "pagedown":
        return moveKeybind(10);
      case "pageup":
        return moveKeybind(-10);
      case "return":
      case "enter":
        return keybindTarget() === null ? capturePrefix() : openKeybindPicker(false);
      case "a":
        return keybindTarget() === null ? capturePrefix() : openKeybindPicker(true);
      case "u":
        return resetBinding(false);
      case "d":
        return resetBinding(true);
      case "s":
        void saveSettings();
        return;
    }
  }

  /**
   * Keys while an item is being edited (focus === "editing").
   *
   * Escape is the only key this owns for a string or number: cursor movement,
   * typing, backspace and Enter all belong to the row's own focused `<input>`,
   * so everything else returns `false` and falls through to it. A boolean has
   * no input to fall through to — there is nothing to type, only a value to
   * flip — so this claims the four directions for it directly.
   */
  function settingsEditKey(event: KeyEvent): boolean {
    const option = selectedOption();
    const spec = option ? specFor(option) : undefined;
    if (!option || !spec) {
      setSettingsFocus("items");
      return true;
    }
    if (event.name === "escape") {
      const original = editOriginal();
      // A boolean autosaves on every flip (below), so undoing one has to write
      // the reversion back too — otherwise disk keeps the last flip while the
      // screen shows the one from before editing.
      if (original !== null) {
        changeOption(option, original);
        if (spec.kind === "boolean") saveOptions();
      }
      setEditOriginal(null);
      setEditText(undefined);
      setSettingsFocus("items");
      return true;
    }
    if (spec.kind === "string" || spec.kind === "number") return false;
    if (event.name === "return" || event.name === "enter") {
      setEditOriginal(null);
      setSettingsFocus("items");
      return true;
    }
    // boolean: any of the four directions flips it — there is no "which way".
    if (["left", "right", "up", "down"].includes(event.name ?? "")) {
      adjustOption(option, 1);
      saveOptions();
    }
    return true;
  }

  /**
   * Whether the key was consumed here. `false` means a focused control (a
   * plugin section's own input, or the edit row's `<input>`) should receive
   * it instead — the caller must not preventDefault, or that control never
   * sees a character.
   *
   * Escape/`q` close the window from either list, but only as a default: a
   * plugin section that explicitly claims a key (returning `true`, as the
   * auth tab does to cancel out of editing rather than close) settles it
   * right there. Checking for that claim ahead of the close shortcut is what
   * keeps "cancel editing" from also closing the whole window on the same
   * keystroke. Escape from "editing" is different again — see
   * `settingsEditKey` — it undoes the value in progress rather than closing.
   */
  function settingsKey(event: KeyEvent): boolean {
    if (settingsFocus() === "editing") return settingsEditKey(event);

    if (settingsFocus() === "sections") {
      switch (event.name) {
        case "escape":
        case "q":
          setOverlay("none");
          return true;
        case "j":
        case "down":
          cycleSettingsSection(1);
          return true;
        case "k":
        case "up":
          cycleSettingsSection(-1);
          return true;
        case "tab":
        case "right":
        case "return":
        case "enter":
          setSettingsFocus("items");
          return true;
      }
      return true;
    }

    // settingsFocus() === "items"
    const pluginSection = pluginSettings().find((section) => section.id === settingsSection());
    if (pluginSection) {
      const handled = pluginSection.keys?.(event, settingsSelected());
      if (handled === false) return false;
      if (handled === true) return true;
      if (event.name === "escape" || event.name === "q") {
        setOverlay("none");
        return true;
      }
      if (event.name === "tab" || event.name === "left") {
        setSettingsFocus("sections");
        return true;
      }
      if (event.name === "j" || event.name === "down")
        setSettingsSelected((s) => Math.min(Math.max(0, pluginSection.rows() - 1), s + 1));
      if (event.name === "k" || event.name === "up") setSettingsSelected((s) => Math.max(0, s - 1));
      return true;
    }
    if (event.name === "escape" || event.name === "q") {
      setOverlay("none");
      return true;
    }
    if (event.name === "tab" || event.name === "left") {
      setSettingsFocus("sections");
      return true;
    }
    // The keybind tab edits sequences rather than values, so it has its own keys.
    if (settingsSection() === "keybinds") {
      keybindsKey(event);
      return true;
    }
    const fields = settingsFields(allOptions(), settingsSection(), optionContributions.all());
    switch (event.name) {
      case "j":
      case "down":
        setSettingsSelected((s) => Math.min(Math.max(0, fields.length - 1), s + 1));
        return true;
      case "k":
      case "up":
        setSettingsSelected((s) => Math.max(0, s - 1));
        return true;
      case "right":
      case "return":
      case "enter": {
        const option = selectedOption();
        if (!option) return true;
        // An option whose value is chosen from a list cannot be edited in
        // place, so the row belongs to the command of the same name and
        // whoever owns the option registers it. `agent.model` is the
        // harness's; core knows only that a command with the option's name
        // exists.
        if (registeredBindings().some((binding) => binding.name === option)) {
          bindings.dispatch(option);
          return true;
        }
        const spec = specFor(option);
        if (!spec || (spec.kind === "string" && !spec.editable)) return true;
        const value = optionValue(option, spec);
        setEditOriginal(value);
        setEditText(spec.kind === "number" ? String(value) : undefined);
        setSettingsFocus("editing");
        return true;
      }
      case "s":
        void saveSettings();
        return true;
    }
    return true;
  }

  function keybindPickerKey(event: KeyEvent) {
    const view = keybindPicker();
    if (!view) return true;
    if (event.name === "escape") {
      if (view.capturing) {
        setCapturing(false);
        setKeybindPicker((current) => (current ? { ...current, capturing: false } : current));
      } else {
        setKeybindPicker(null);
      }
      return true;
    }
    if (view.capturing) return true;
    if (event.name === "j" || event.name === "down") {
      setKeybindPicker((current) =>
        current
          ? {
              ...current,
              selected: Math.min(current.entries.length - 1, current.selected + 1),
            }
          : current,
      );
      return true;
    }
    if (event.name === "k" || event.name === "up") {
      setKeybindPicker((current) =>
        current ? { ...current, selected: Math.max(0, current.selected - 1) } : current,
      );
      return true;
    }
    if (event.name === "return" || event.name === "enter") {
      const command = view.entries[view.selected]?.name;
      if (command) captureBinding(command, view.add);
      return true;
    }
    return false;
  }

  /** Write the config file. Answers with the failure message, because the two
   *  callers show it in different places: the settings window has an error line,
   *  a panel that saves has only the command-error banner. */
  async function persistConfig(): Promise<string | null> {
    try {
      await saveConfig(configState());
      setSettingsDirty(false);
      return null;
    } catch (error) {
      return `could not save settings: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function saveSettings() {
    setSettingsError((await persistConfig()) ?? "");
  }

  function saveOptions() {
    void persistConfig().then((failure) => {
      if (failure) showCommandError(failure);
    });
  }

  const bindings = createBindings(renderer, COMMANDS, {
    keys: config.keys,
    onUnhandled,
    onError: showCommandError,
  });
  setConflicts(bindings.conflicts());
  const bindingTable = contributions.table<CommandSpec>();
  const [registeredBindings, setRegisteredBindings] =
    createSignal<readonly CommandSpec[]>(COMMANDS);
  // Bindings reach the keymap through an effect rather than a call in
  // `registerBinding`, because a plugin's bindings also appear and disappear
  // when the host commits or retires the instance that registered them, and
  // nobody calls `registerBinding` at that moment.
  createEffect(() => {
    const next = [...COMMANDS, ...bindingTable.all().map((entry) => entry.value)];
    setRegisteredBindings(next);
    setConflicts(bindings.setCommands(next));
  });
  const registerBinding = (owner: PluginInstance, binding: CommandSpec) => {
    if (COMMANDS.some((entry) => entry.name === binding.name))
      throw new Error(`binding '${binding.name}' is a built-in command`);
    return bindingTable.add(owner, binding.name, binding);
  };
  const registerSettingsSection = (owner: PluginInstance, section: PluginSettingsSection) =>
    settingsSectionTable.add(owner, section.id, section);
  const registerOption = (owner: PluginInstance, name: string, spec: OptionSpec) => {
    if (optionSpec(name)) throw new Error(`option '${name}' is a built-in option`);
    return optionContributions.add(owner, name, spec);
  };

  function updateHintVisibility(sequence: readonly { display: string }[]) {
    runFiber("hint-delay", Effect.void);
    setPendingParts(sequence);
    const visibility = hintVisibility(
      sequence.length,
      options()["appearance.whichKeyHints"],
      options()["appearance.whichKeyDelay"],
    );
    if (!visibility.visible && visibility.delayMs === 0) {
      setHintsVisible(false);
      return;
    }
    if (visibility.visible) {
      setHintsVisible(true);
      return;
    }
    setHintsVisible(false);
    scheduleHintVisibility(
      runFiber,
      visibility.delayMs,
      () => pendingParts().length > 0,
      () => setHintsVisible(true),
    );
  }

  // Only source of truth for the hint line and the which-key panel: what the
  // keymap will actually do next, so a rebinding shows up in both without
  // touching this file.
  const disposePendingSequence = bindings.keymap.on("pendingSequence", updateHintVisibility);

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
    applyOptions(options());
    syncPaneFrame();
  });

  // The keymap's own event covers the sequence changing; this covers the two
  // options that decide what to do with it.
  createEffect(
    on(
      () => [options()["appearance.whichKeyHints"], options()["appearance.whichKeyDelay"]],
      () => updateHintVisibility(pendingParts()),
    ),
  );

  const pending = createMemo(() =>
    pendingParts().length ? [formatSequence(pendingParts(), configState().keys.leader)] : [],
  );
  const hints = createMemo(() => nextKeys(bindings, [...registeredBindings()], pendingParts()));

  // Recomputed whenever the keys change, since that is what the list is *for*:
  // the reference and the editor are the same rows, read back out of the keymap
  // that was just rebuilt.
  const groups = createMemo(() =>
    helpGroups(bindings, [...registeredBindings()], configState().keys),
  );
  const allPaletteEntries = createMemo(() => paletteEntries(bindings, [...registeredBindings()]));
  const filteredPalette = createMemo(() =>
    filterPaletteEntries(allPaletteEntries(), paletteQuery()),
  );

  function submitPalette() {
    const entry = filteredPalette()[paletteSelected()];
    if (!entry) return;
    setOverlay("none");
    bindings.dispatch(entry.name);
  }

  /** Whether the focused window's tab carries the copy-mode marker. Reads the
   *  copy-mode pane directly and refreshes on app revision, which copy-mode
   *  entry and exit bump through onStateChange. */
  const copying = createMemo(() => {
    app.tick();
    const pane = copyMode.pane;
    return pane !== null && (spaces.activeWindow?.panes.includes(pane) ?? false);
  });

  /** Refresh every space's branch/ahead-behind. Polled because git state changes
   *  behind our back with nothing to notify us. */
  const refreshGit = Effect.gen(function* () {
    for (const space of spaces.spaces) {
      const info = yield* Effect.promise(() => readGit(space.dir));
      if (
        info.branch === space.branch &&
        info.ahead === space.ahead &&
        info.behind === space.behind
      )
        continue;
      space.branch = info.branch;
      space.ahead = info.ahead;
      space.behind = info.behind;
      app.refresh();
    }
  });

  /** Ask the owning Effect program to close its scope. Backend ownership makes
   * that release kill local PTYs and merely detach daemon projections. */
  function shutdown() {
    quit();
  }

  /**
   * Everything amux puts on screen, as panels.
   *
   * The app registers its own views through the registry a plugin will, so
   * there is one way for a panel to exist rather than a built-in layout with a
   * plugin API bolted beside it. Nothing outside this file can register yet.
   *
   * A panel is a value: where it goes, how big it is, when it is up, what it
   * draws and — for a modal — what it does with the keys the keymap did not
   * claim. The overlays' `order` is the modal stack, so the one drawn on top is
   * the one asked about a keystroke first.
   */
  function registerPanels(): () => void {
    const registerCorePanel = (panel: Panel) => regions.register(CORE_CONTRIBUTOR, panel);
    const disposers = [
      registerCorePanel({
        id: "amux.windows",
        region: "top",
        // The pane area, not the app: amux has no app-wide bar, and a tab row
        // above the sidebar is a different program.
        anchor: "center",
        title: "windows",
        // Always present, even at one window — a tab bar that appears and
        // disappears shifts the whole pane area by a row, and it is where the
        // prefix indicator lives.
        size: () => 1,
        component: () => (
          <WindowTabs
            app={app}
            processDisplay={processDisplay}
            windows={app.active()?.windows ?? []}
            active={app.activeWindow()}
            spaceIndex={app.active() ? spaces.spaces.indexOf(app.active()!) : undefined}
            spaceName={app.active()?.name}
            branch={app.active()?.branch}
            gitAhead={app.active()?.ahead}
            gitBehind={app.active()?.behind}
            format={options()["window.format"]}
            status={(() => {
              app.tick();
              const space = app.active();
              const window = app.activeWindow();
              const pane = window?.focused?.session ?? null;
              const state = pane?.state;
              const display = pane
                ? processDisplay.display({
                    state: pane.state,
                    exitCode: pane.exitCode,
                    detached: pane.detached,
                  })
                : undefined;
              const spaceIndex = space ? spaces.spaces.indexOf(space) : undefined;
              return formatText(options()["status.format"], {
                active: true,
                space_name: space?.name,
                space_index: spaceIndex,
                branch: space?.branch,
                git_branch: space?.branch,
                git_ahead: space?.ahead,
                git_behind: space?.behind,
                window_name: window?.title,
                window_number: window?.number,
                pane_index: pane ? window?.sessions.indexOf(pane) : undefined,
                pane_title: pane?.title,
                pane_current_command: pane?.foregroundCommand,
                agent_state: display?.label,
                agent_state_label: display?.label,
                agent_state_glyph: display
                  ? state === ProcessState.Running
                    ? SPINNER_FRAMES[app.frame() % SPINNER_FRAMES.length]
                    : display.glyph
                  : "",
                zoomed: window?.zoomed,
                synchronized: window?.sync,
                sync: window?.sync,
                scrolled: pane?.scrolled,
                exited: pane?.exited,
                viewers: pane?.viewers,
                unseen: pane?.unseen,
              });
            })()}
            pending={pending()}
            copying={copying()}
            onSelect={(w) => {
              const space = spaces.active;
              if (space) {
                runProjectedCommand(
                  command("window.select", {
                    space: space.id,
                    number: w.number,
                  }),
                );
              }
            }}
          />
        ),
      }),
      registerCorePanel({
        id: "amux.settings",
        region: "overlay",
        order: 10,
        title: "settings",
        visible: () => overlay() === "settings",
        keys: (event) => settingsKey(event),
        component: (props) => (
          <Settings
            options={allOptions()}
            section={settingsSection()}
            selected={settingsSelected()}
            groups={groups()}
            leader={configState().keys.leader}
            conflicts={conflicts()}
            capturing={capturing()}
            width={props.width}
            height={props.height}
            dirty={settingsDirty()}
            error={settingsError()}
            onKeybindList={(box) => {
              keybindList = box;
            }}
            pluginSections={pluginSettings()}
            registeredOptions={optionContributions.all()}
            focus={settingsFocus()}
            editText={editText()}
            onEditInput={(value) => {
              const option = selectedOption();
              const spec = option ? specFor(option) : undefined;
              if (!option || !spec) return;
              if (spec.kind === "number") {
                setEditText(value);
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) return;
                const coerced = coerceOption(spec, parsed);
                if (coerced === undefined) return;
                changeOption(option, coerced);
                saveOptions();
                return;
              }
              changeOption(option, value);
            }}
            onEditSubmit={() => {
              setEditOriginal(null);
              setEditText(undefined);
              setSettingsFocus("items");
              saveOptions();
            }}
          />
        ),
      }),
      registerCorePanel({
        id: "amux.keybind-picker",
        region: "overlay",
        order: 15,
        title: "keybind picker",
        visible: () => keybindPicker() !== null,
        keys: keybindPickerKey,
        component: (props) => (
          <Show when={keybindPicker()}>
            {() => (
              <KeybindPicker
                view={keybindPicker()!}
                width={props.width}
                onSubmit={() => {
                  const current = keybindPicker();
                  const command = current?.entries[current.selected]?.name;
                  if (command && current) captureBinding(command, current.add);
                }}
                onInput={(query) =>
                  setKeybindPicker((current) =>
                    current
                      ? {
                          ...current,
                          query,
                          selected: 0,
                          entries: sortKeybindEntries(
                            filterPaletteEntries(allPaletteEntries(), query),
                          ),
                        }
                      : current,
                  )
                }
              />
            )}
          </Show>
        ),
      }),
      registerCorePanel({
        id: "amux.palette",
        region: "overlay",
        // Same rung as settings: one signal holds both, so they cannot be up at
        // the same time.
        order: 10,
        title: "commands",
        visible: () => overlay() === "palette",
        keys: (event) => {
          if (event.name === "escape") {
            setOverlay("none");
            return true;
          }
          return paletteKey(event);
        },
        component: (props) => (
          <CommandPalette
            entries={filteredPalette()}
            query={paletteQuery()}
            selected={paletteSelected()}
            width={props.width}
            onInput={(value) => {
              setPaletteQuery(value);
              setPaletteSelected(0);
            }}
            onSubmit={submitPalette}
          />
        ),
      }),
      registerCorePanel({
        id: "amux.buffers",
        region: "overlay",
        order: 20,
        title: "buffers",
        visible: () => chooseView() !== null,
        // ↑↓ picks, enter pastes the selection into the focused pane, d deletes
        // it, escape closes. With no buffers there is nothing to pick, so only
        // escape does anything.
        keys: (event) => {
          const view = chooseView();
          if (!view) return true;
          const count = view.buffers.length;
          if (event.name === "j" || event.name === "down") {
            setChooseView((v) =>
              v
                ? {
                    ...v,
                    selected: count === 0 ? 0 : Math.min(count - 1, v.selected + 1),
                  }
                : v,
            );
          } else if (event.name === "k" || event.name === "up") {
            setChooseView((v) => (v ? { ...v, selected: Math.max(0, v.selected - 1) } : v));
          } else if (event.name === "pagedown") {
            setChooseView((v) =>
              v
                ? {
                    ...v,
                    selected: count === 0 ? 0 : Math.min(count - 1, v.selected + 10),
                  }
                : v,
            );
          } else if (event.name === "pageup") {
            setChooseView((v) => (v ? { ...v, selected: Math.max(0, v.selected - 10) } : v));
          } else if (event.name === "return" || event.name === "enter") {
            const name = view.buffers[view.selected]?.name;
            if (name) view.onPaste(name);
          } else if (event.name === "d") {
            const name = view.buffers[view.selected]?.name;
            if (name) view.onDelete(name);
          } else if (event.name === "escape") {
            view.onClose();
          }
          return true;
        },
        component: (props) => (
          <Show when={chooseView()} keyed>
            {(view: BufferChooseView) => (
              <BufferChoose view={view} width={props.width} height={props.height} />
            )}
          </Show>
        ),
      }),
      registerCorePanel({
        id: "amux.capture",
        region: "overlay",
        order: 30,
        title: "capture",
        visible: () => captureView() !== null,
        // s writes the file, f re-captures the other span, escape backs out
        // without saving. Everything else stays with the popup.
        keys: (event) => {
          const view = captureView();
          if (!view) return true;
          if (event.name === "s") view.onSave();
          else if (event.name === "f") view.onToggleSpan();
          else if (event.name === "escape") view.onClose();
          return true;
        },
        component: (props) => (
          <Show when={captureView()} keyed>
            {(view: CaptureView) => (
              <Capture view={view} width={props.width} height={props.height} />
            )}
          </Show>
        ),
      }),
      registerCorePanel({
        id: "amux.prompt",
        region: "overlay",
        // Top of the stack: a prompt is opened *by* the overlays below it, and
        // the answer it is waiting for is the only thing the keyboard is for
        // while it is up.
        order: 40,
        title: "prompt",
        visible: () => promptRequest() !== null,
        keys: (event) => {
          const request = promptRequest();
          if (!request) return true;
          // A notice is a message, not a form: nothing is focused to hand the
          // key to, so every key is consumed here and enter/escape dismiss it.
          if (request.notice) {
            if (event.name === "escape" || event.name === "return" || event.name === "enter") {
              request.resolve(null);
            }
            return true;
          }
          // Escape cancels; everything else belongs to the focused input, so
          // leave the event alone and let focus routing deliver it.
          if (event.name === "escape") {
            request.resolve(null);
            return true;
          }
          return false;
        },
        component: (props) => (
          <Show when={promptRequest()} keyed>
            {(request: PromptRequest) => (
              <Prompt request={request} width={props.width} error={promptError()} />
            )}
          </Show>
        ),
      }),
      registerCorePanel({
        id: "amux.hints",
        region: "float",
        title: "which-key",
        // Only while a sequence is half-typed, and never over a modal — an
        // overlay that is already answering "what now?" does not need a second
        // one on top of it.
        visible: () => hintsVisible() && hints().length > 0 && regions.topOverlay() === null,
        component: (props) => (
          <Hints
            groups={hints()}
            pending={pending().join(" ")}
            left={props.left}
            width={props.width}
            height={props.height}
          />
        ),
      }),
      registerCorePanel({
        id: "amux.disconnected",
        region: "overlay",
        order: 50,
        title: "disconnected",
        visible: () => daemonDisconnected(),
        keys: (event) => {
          if (event.name === "escape" || event.name === "q") shutdown();
          return true;
        },
        component: (props) => (
          <box
            style={{
              position: "absolute",
              width: 58,
              height: 5,
              flexDirection: "column",
              backgroundColor: theme.base,
              border: true,
              borderColor: theme.red,
              padding: 1,
              zIndex: 400,
              left: Math.max(0, Math.floor((props.width - 58) / 2)),
              top: Math.max(0, Math.floor((props.height - 5) / 2)),
            }}
            title=" daemon disconnected "
          >
            <text style={{ fg: theme.red, height: 1 }}>The daemon has stopped.</text>
            <text style={{ height: 1 }}>Session is gone; every command</text>
            <text style={{ fg: theme.overlay1, height: 1, marginTop: 1 }}>
              ^a q / q / escape — exit
            </text>
          </box>
        ),
      }),
      registerCorePanel({
        id: "amux.error",
        region: "overlay",
        order: 55,
        title: "error",
        visible: () => commandError() !== null,
        keys: () => {
          setCommandError(null);
          return true;
        },
        component: () => (
          <box
            style={{
              position: "absolute",
              width: "100%",
              // Border rows are part of the box, so a bordered banner holding
              // one line of text is three rows tall. Asking for one row put the
              // message on the bottom border — below the screen, where nothing
              // reported a command failure at all.
              height: 3,
              backgroundColor: theme.base,
              border: true,
              borderColor: theme.red,
              zIndex: 500,
              left: 0,
              bottom: 0,
            }}
          >
            <text style={{ fg: theme.red, height: 1 }}>{commandError() ?? ""}</text>
          </box>
        ),
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  const disposePanels = registerPanels();

  // Before the first window exists, so its panes are built with the right edges.
  syncPaneFrame();
  // Initial status is the reconnect snapshot; later generations arrive on the
  // model stream. The client never invents a fallback workspace of its own.
  const initialWorkspace = session.workspace();
  run(projectWorkspace(spaces, initialWorkspace, session.backend()));
  projectedRevision = initialWorkspace.revision;
  installModelCallbacks();
  syncPaneFrame();
  // Keyed, so a refresh still running when the next one is due is replaced
  // rather than queued behind it: a git call that hangs must not build a
  // backlog of scans of state it has already been superseded by.
  const refreshGitNow = () => runFiber("git-refresh", refreshGit);
  refreshGitNow();
  runFiber("git-poll", scheduledPoll(5000, refreshGitNow));
  const View = () => (
    <App
      regions={regions}
      paneHost={paneHost}
      size={size()}
      padding={options()["appearance.padding"] ? 1 : 0}
    />
  );

  const release = Effect.gen(function* () {
    disposed = true;
    // Stop supervised callbacks before releasing anything they can touch.
    yield* Scope.close(fiberScope, Exit.void);
    // A projection already handed to a Promise cannot be interrupted. Let it
    // finish before releasing any UI object it can still refresh.
    yield* Effect.promise(() => projection).pipe(
      Effect.timeout("2 seconds"),
      Effect.catchAll(() =>
        Effect.logWarning("workspace projection did not finish during shutdown"),
      ),
    );
    // While the pane is still alive: the mode's exit clears the selection
    // through the pane's terminal, and a freed terminal cannot be caught.
    if (copyMode.active) copyMode.exit();
    frame.externalLeft = initialFrameExternalLeft;
    spaces.refreshChrome();
    disposePendingSequence();
    disposePanels();
    bindings.dispose();
    renderer.removeListener("resize", onResize);
  });

  /** Core options plus every plugin-registered one, resolved by the same rule —
   *  what a plugin reads through `ctx.panel.options()`. */
  const allOptions = () => {
    const merged = { ...options() } as Options & Record<string, OptionValue>;
    for (const entry of optionContributions.all())
      merged[entry.name] = optionValue(entry.name, entry.value);
    return merged as Options & Record<string, OptionValue>;
  };

  const panel = createPanelContext({
    snapshot,
    tick: app.tick,
    run: (command, input) => runCommand(command, input).pipe(Effect.as(session.workspace())),
    options: allOptions,
    setOption: changeOption,
    saveOptions,
    display,
    reportError: showCommandError,
    selectedAgentId,
    setSelectedAgentId,
  });
  return {
    View,
    panel,
    release,
    registerBinding,
    registerSettingsSection,
    registerOption,
    commands,
  };
}
