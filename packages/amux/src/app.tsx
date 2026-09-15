/** @jsxImportSource @opentui/solid */
import {
  BoxRenderable,
  ClipboardTarget,
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { Show, createSignal, createMemo, createEffect, on } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ValidComponent } from "solid-js";
import {
  Context,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Option,
  Result,
  Scope,
  Stream,
  Schema as S,
} from "effect";
import { theme, setTheme } from "./ui/theme.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- path access is part of the plain render-tree boundary.
import { basename, join } from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- file output is part of the plain render-tree boundary.
import { writeFile } from "node:fs/promises";
import { ProcessState } from "./process-state.ts";

import { projectWorkspace, SpaceSet } from "./space.ts";
import { LAYOUT_PRESETS, layoutRefs, type LayoutPreset } from "./layout.ts";
import { TerminalPane } from "./pane.ts";
import { readGit } from "./git.ts";
import { createKeyDispatcher, sendKeys, type SendTarget } from "./send.ts";
import { NO_REALM, paneRealm, realmOf } from "./realm.ts";
import {
  createBindings,
  helpGroups,
  nextKeys,
  formatSequence,
  formatKey,
  parseKeyStrokes,
  keysFor,
  DEFAULT_PREFIX,
  DEFAULT_LEADER,
  type CommandSpec,
  type Conflict,
  type Keys,
  filterPaletteEntries,
  mayDispatchPaletteEntry,
  paletteEntries,
} from "./bindings.ts";
import { KeyInvocation } from "./key-invocation.ts";
import {
  COMMAND_META,
  CommandError,
  command,
  commandInvocation,
  CurrentInvocation,
  decodeCoreCommandResult,
  makeCommands,
  isCoreCommand,
  runDetached,
  WireCommand,
  type Command,
  type CommandHandlers,
  type CommandInvocation,
  type CommandTag,
  type CommandResult,
  type RegisteredCommand,
} from "./commands.ts";
import { saveConfig as saveConfigEffect, type Config } from "./config.ts";
import {
  adjustedValue,
  applyOptions,
  clearOption,
  coerceOption,
  optionNames,
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
import { createSlots, type DockOccupant, type OverlayOccupant } from "./ui/slots.ts";
import {
  createPluginContributions,
  type PluginContributions,
  type PluginInstance,
} from "./plugin/contributions.ts";

import { createPluginHost, type PluginHost } from "./plugin/host.ts";
import { type PluginEntry } from "./plugin/loader.ts";
import { makeOverlay, OverlayTag, type OverlayKind } from "./plugin/overlay.ts";
import {
  CommandsChromeTag,
  SettingsChromeTag,
  type CommandsChrome,
  type SettingsChrome,
} from "./plugin/chrome.ts";
import settingsPlugin from "./plugins/settings.tsx";
import commandsPlugin from "./plugins/commands.tsx";
import {
  BindingsTag,
  CommandsTag,
  ContextsTag,
  CurrentPlugin,
  OptionsTag,
  PanelTag,
  ProcessDisplayTag,
  LayoutKindsTag,
  RemoteEventsTag,
  SessionViewsTag,
  SessionFactsTag,
  SessionStreamTag,
  SettingsTag,
  SlotsTag,
  SpawnProvidersTag,
  scopedRegistry,
  type BindingsService,
  type CommandRegistration,
  type CommandsService,
  type ContextsService,
  type EnumValueRegistration,
  type LayoutKindsService,
  type OptionsService,
  type ProcessDisplayService,
  type SlotsService,
  type SlotsRegisterValue,
  type SessionViewsService,
  type SettingsService,
  type SpawnProvidersService,
} from "./plugin/services.ts";
import {
  CONTEXT_PRIORITY,
  findContextPriorityConflicts,
  overlayBlocksPane,
  resolveUnhandled,
  type ContextSpec,
} from "./key-context.ts";
import { makeSessionFacts } from "./session-facts.ts";
import { formatInspectResult, inspect, type InspectCatalog } from "./plugin/inspect.ts";
import { hotImport } from "./plugin/hot.ts";
import type { PluginPublicationAnnouncement } from "./plugin/ui-announcement.ts";
import {
  defineConsumer,
  definePlugin,
  type PluginConsumer,
  type PluginDefinition,
} from "./plugin/types.ts";
import { WindowTabs } from "./ui/WindowTabs.tsx";
import { formatText } from "./format.ts";
import { type PromptRequest } from "./ui/Prompt.tsx";
import { hintVisibility } from "./ui/Hints.tsx";
import {
  settingsFields,
  keybindTargets,
  LEADER_TARGET,
  type SettingsSection,
} from "./ui/Settings.tsx";
import {
  captureFrameRect,
  captureSpan,
  pickCaptureTarget,
  type CaptureSpan,
  type CaptureTarget,
} from "./capture.ts";
import { Capture, type CaptureView } from "./ui/Capture.tsx";
import { BufferChoose, type BufferChooseView } from "./ui/BufferChoose.tsx";
import { sortKeybindEntries, type KeybindPickerView } from "./ui/KeybindPicker.tsx";
import { CopyMode } from "./copy.ts";
import type { BufferEntry } from "./effect/BufferStore.ts";
import { scheduledPoll } from "./effect/timer.ts";
import { captureRootRuntime, workspaceEnv, type RootRuntimeContext } from "./env.ts";
import type { SidebarDisplayRow, SidebarDisplay } from "./ui/panel.ts";
import type { PluginSettingsSection, SpawnProvider } from "./plugin/types.ts";
import { createSessionViews } from "./plugin/session-views.tsx";
import { createProcessDisplay, type ProcessDisplayProvider } from "./plugin/process-display.ts";
import { createLayoutKinds, type LayoutKindRenderer } from "./layout-kinds.ts";
import type { PaneView } from "./component-pane.tsx";
import { ComponentPane } from "./component-pane.tsx";
import { errorMessage } from "./error-message.ts";
import type { Pane } from "./pane.ts";

/** app.tsx sits on the render/plain-async side of the seam (see harness.ts): it
 *  crosses into the Effect service layer via the workspace RootRuntime captured
 *  in createApp / buildApp (`runPromiseWith` / `runDetached(..., rootRuntime)`). */
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
  host?: PluginHost;
  /** Announced UI entry URLs by plugin id — inspect / remount provenance. */
  uiSource?: (id: string) => URL | undefined;
  pathFor?: (id: string) => string | undefined;
  resumePending?: (workspace: WorkspaceSnapshot) => Effect.Effect<void>;
  /**
   * Remount every window from the current workspace snapshot. Used after
   * plugins finish loading so layout-kind renderers (niri's `scroll`, …)
   * that were missing on the initial project take effect — without a later
   * daemon revision, the fallback flex box would stick forever.
   */
  remountLayouts?: () => Promise<void>;
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
  command: Command | RegisteredCommand,
  workspace: () => Effect.Effect<A, CommandError>,
  session: () => Effect.Effect<B, CommandError>,
): Effect.Effect<A | B, CommandError> {
  return isCoreCommand(command) && COMMAND_META[command._tag].target === "workspace"
    ? workspace()
    : session();
}

interface ManagedAppHandle extends Omit<AppHandle, "pluginHost"> {
  readonly release: Effect.Effect<void>;
  readonly commands: CommandsService;
  readonly coreEntries: readonly PluginDefinition[];
  readonly pluginEntries: readonly PluginEntry[];
  readonly registryEntries: readonly PluginDefinition[];
  readonly consumers: readonly PluginConsumer[];
  readonly updateRegistry: (host: PluginHost, key: string) => void;
}

interface ProviderRef<A extends object> {
  readonly value: A;
  readonly set: (value: A) => void;
}

function providerRef<A extends object>(initial: A): ProviderRef<A> {
  const [current, setCurrent] = createSignal(initial);
  return {
    value: new Proxy(initial, {
      get: (_target, property) => Reflect.get(current(), property),
    }),
    set: setCurrent,
  };
}

interface RegistryBinding {
  readonly key: string;
  readonly plugin: PluginDefinition;
  readonly refresh: (host: PluginHost) => void;
}

/**
 * One registry, stated once: the entry that provides it by default and the
 * handler that re-reads it when its provider changes both come from this row,
 * so a registry cannot be published under one tag and read back under another.
 *
 * `refresh` falls back to the shipped service when no provider is visible.
 * A withdrawn provider must not leave the app reading a service that is gone.
 */
function registry<Id, S extends object>(
  name: string,
  tag: Context.Service<Id, S>,
  ref: ProviderRef<S>,
  fallback: S,
): RegistryBinding {
  return {
    key: tag.key,
    plugin: definePlugin({
      id: `amux.registry.${name}`,
      provide: [tag],
      effect: (ctx) => Effect.sync(() => void ctx.provide(tag, fallback)),
    }),
    refresh: (host) => ref.set(Option.getOrElse(host.get(tag), () => fallback)),
  };
}

/** A synchronous launcher captured from the app's scoped FiberMap. */
export type AppFiberRunner = (key: string, effect: Effect.Effect<void>) => void;

/** The two modals that share one slot, because opening either closes the
 *  other: they are the same window in the user's head. */
export type Overlay = OverlayKind;

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
  // The one mutable Options object this workspace's panes, windows and
  // dividers all read at render/event time; see OptionsRuntime in env.ts.
  // Kept in step by the reactive effect below via applyOptions.
  const optionsRuntime = resolveOptions(options.config.options);
  // Theme is process-wide chrome (Solid + highlight share one table). Apply
  // before the first paint so the default ansi palette is live from frame 0.
  setTheme(optionsRuntime["appearance.theme"]);
  const initialShell = [
    // @effect-diagnostics-next-line processEnv:off -- initial shell fallback is evaluated before the Effect program starts.
    optionsRuntime["behaviour.shell"] || process.env.SHELL || "bash",
  ];
  return Effect.gen(function* () {
    // Captured here rather than threaded in through AppOptions: whatever
    // Layer main.tsx provided is already ambient in this fiber, and this is
    // the one place a workspace's Effect context is built from. See
    // RootRuntime in env.ts.
    const rootRuntime = yield* captureRootRuntime;
    const fiberScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(fiberScope, Exit.void));
    const fibers = yield* Scope.provide(FiberMap.make<string>(), fiberScope);
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
    const layoutKinds = createLayoutKinds(contributions);
    const sessionViewsService = scopedRegistry(
      { view: sessionViews.view, has: sessionViews.has, ownerOf: sessionViews.ownerOf },
      (owner, [type, view]: readonly [string, PaneView]) =>
        sessionViews.register(owner, type, view),
    );
    const processDisplayService = scopedRegistry(
      { display: processDisplay.display },
      (owner, provider: ProcessDisplayProvider) => processDisplay.register(owner, provider),
    );
    const layoutKindsService = scopedRegistry(
      { renderer: layoutKinds.renderer },
      (owner, [kind, renderer]: readonly [string, LayoutKindRenderer]) =>
        layoutKinds.register(owner, kind, renderer),
    );
    const sessionViewsProvider = providerRef<SessionViewsService>(sessionViewsService);
    const processDisplayProvider = providerRef<ProcessDisplayService>(processDisplayService);
    const layoutKindsProvider = providerRef<LayoutKindsService>(layoutKindsService);
    const spaces = yield* SpaceSet.make(
      workspaceEnv(options.renderer, {
        shell: initialShell,
        backend: options.session.backend(),
        paneContent: (props) => sessionViewsProvider.value.view(props),
        layoutKinds: (kind) => layoutKindsProvider.value.renderer(kind),
        options: optionsRuntime,
        runtime: rootRuntime,
      }),
      options.paneHost,
    );
    let pluginHost: PluginHost | undefined;
    const slots = createSlots(options.renderer, contributions, optionsRuntime);
    const slotsService = scopedRegistry(
      {
        Slot: slots.Slot,
        declared: slots.declared,
        thickness: slots.thickness,
        divider: slots.divider,
        topOverlay: slots.topOverlay,
      },
      (owner, entry: SlotsRegisterValue) => {
        // The union discriminant narrows each branch onto the matching
        // `Slots.register` overload — a mismatched pair fails to compile.
        if (entry.slot === "overlay")
          return slots.register(owner, entry.slot, entry.occupant, entry.priority);
        if (entry.slot === "float")
          return slots.register(owner, entry.slot, entry.occupant, entry.priority);
        return slots.register(owner, entry.slot, entry.occupant, entry.priority);
      },
    );
    const slotsProvider = providerRef<SlotsService>(slotsService);
    const spawnProviders = contributions.table<() => SpawnProvider>();
    const spawnProvidersService = scopedRegistry(
      { get: (id: string) => spawnProviders.get(id)?.() },
      (owner, [id, provider]: readonly [string, () => SpawnProvider]) =>
        spawnProviders.add(owner, id, provider),
    );
    const spawnProvidersProvider = providerRef<SpawnProvidersService>(spawnProvidersService);
    const pluginRuntime: PluginRuntime = {};
    const app = yield* Effect.acquireRelease(
      Effect.sync(() =>
        buildApp(
          options,
          spaces,
          fiberScope,
          runFiber,
          slotsProvider.value,
          contributions,
          pluginRuntime,
          processDisplayProvider.value,
          optionsRuntime,
          rootRuntime,
          {
            slots: slotsProvider,
            sessionViews: sessionViewsProvider,
            processDisplay: processDisplayProvider,
            layoutKinds: layoutKindsProvider,
            spawnProviders: spawnProvidersProvider,
          },
          {
            slots: slotsService,
            sessionViews: sessionViewsService,
            processDisplay: processDisplayService,
            layoutKinds: layoutKindsService,
            spawnProviders: spawnProvidersService,
          },
        ),
      ),
      (app) => app.release,
    );
    pluginHost = yield* createPluginHost({ contributions, consumers: app.consumers });
    pluginRuntime.host = pluginHost;
    runFiber(
      "plugin-service-changes",
      Stream.runForEach(pluginHost.onServiceChange, (key) =>
        Effect.sync(() => app.updateRegistry(pluginHost, key)),
      ),
    );
    const uiByKey = new Map<
      string,
      { readonly digest: string; readonly definition: PluginDefinition; readonly source: URL }
    >();
    let pluginEntries: readonly PluginEntry[] = [...app.pluginEntries];
    const resumedPending = new Set<string>();
    const resumePending = (workspace: WorkspaceSnapshot) =>
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
          const provider = spawnProvidersProvider.value.get(session.provider!);
          return options.session
            .resumeAgent({
              session: session.id,
              provider: session.provider!,
              argv: provider?.argv,
              env: provider?.env,
              stripEnv: provider?.stripEnv,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  app.panel.reportError(errorMessage(error));
                }),
              ),
            );
        },
        { discard: true },
      );
    pluginRuntime.resumePending = resumePending;
    pluginRuntime.uiSource = (id) => {
      for (const value of uiByKey.values()) {
        if (value.definition.id === id) return value.source;
      }
      return undefined;
    };
    pluginRuntime.pathFor = (id) => pluginEntries.find((plugin) => plugin.id === id)?.path;

    const applyPublication = (announcement: PluginPublicationAnnouncement) =>
      Effect.gen(function* () {
        const nextDefs: PluginDefinition[] = [...app.registryEntries, ...app.coreEntries];
        const reportPlugins: {
          readonly key: string;
          readonly digest: string;
          readonly ready: boolean;
          readonly error?: string;
        }[] = [];
        for (const half of announcement.plugins) {
          if (half.uiEntry === undefined) {
            const prior = uiByKey.get(half.key);
            if (prior !== undefined) nextDefs.push(prior.definition);
            reportPlugins.push({
              key: half.key,
              digest: half.digest,
              ready: prior !== undefined,
            });
            continue;
          }
          const prior = uiByKey.get(half.key);
          if (prior !== undefined && prior.digest === half.digest) {
            nextDefs.push(prior.definition);
            reportPlugins.push({ key: half.key, digest: half.digest, ready: true });
            continue;
          }
          const imported = yield* hotImport(new URL(half.uiEntry)).pipe(Effect.result);
          if (Result.isFailure(imported)) {
            if (prior !== undefined) nextDefs.push(prior.definition);
            reportPlugins.push({
              key: half.key,
              digest: half.digest,
              ready: false,
              error: imported.failure,
            });
            app.panel.reportError(`${half.key}: ${imported.failure}`);
            continue;
          }
          nextDefs.push(imported.success);
          uiByKey.set(half.key, {
            digest: half.digest,
            definition: imported.success,
            source: new URL(half.uiEntry),
          });
          reportPlugins.push({ key: half.key, digest: half.digest, ready: true });
        }
        const prepared = yield* pluginHost.prepare(nextDefs).pipe(Effect.result);
        if (Result.isFailure(prepared)) {
          app.panel.reportError(errorMessage(prepared.failure));
          yield* options.session.reportPluginUiReady({
            revision: announcement.revision,
            plugins: reportPlugins.map((plugin) => ({ ...plugin, ready: false })),
          });
          return;
        }
        yield* pluginHost.publish.pipe(
          Effect.catch((error) => Effect.sync(() => app.panel.reportError(errorMessage(error)))),
        );
        pluginEntries = [
          ...app.pluginEntries,
          ...[...uiByKey.entries()].map(([key, value]) => ({
            id: value.definition.id,
            path: key,
            source: value.source,
            definition: value.definition,
          })),
        ];
        yield* resumePending(options.session.workspace());
        if (pluginRuntime.remountLayouts) {
          yield* Effect.promise(() => pluginRuntime.remountLayouts!());
        }
        yield* options.session.reportPluginUiReady({
          revision: announcement.revision,
          plugins: reportPlugins,
        });
      });

    // Core/registry entries only; user UI halves follow PluginPublications.
    runFiber(
      "plugin-load",
      Effect.gen(function* () {
        const prepared = yield* pluginHost
          .prepare([...app.registryEntries, ...app.coreEntries])
          .pipe(Effect.result);
        if (Result.isFailure(prepared)) {
          app.panel.reportError(errorMessage(prepared.failure));
          return;
        }
        yield* pluginHost.publish.pipe(
          Effect.catch((error) => Effect.sync(() => app.panel.reportError(errorMessage(error)))),
        );
        yield* Stream.runForEach(options.session.pluginPublications, (announcement) =>
          applyPublication(announcement).pipe(
            Effect.catch((error) => Effect.sync(() => app.panel.reportError(errorMessage(error)))),
          ),
        );
      }),
    );
    runFiber(
      "plugin-errors",
      Stream.runForEach(pluginHost.onError, (event) =>
        Effect.sync(() => app.panel.reportError(`${event.pluginId}: ${event.error.message}`)),
      ),
    );
    // A CLI invocation of a plugin command has no registry of its own to run
    // it against — the daemon runs no plugins — so it lands here, on whichever
    // client the daemon picked, and gets executed against this client's own
    // `commands.run`, exactly as a keybinding would.
    runFiber(
      "command-requests",
      Stream.runForEach(
        options.session.commandRequests,
        ({ id, command: raw, source, pane, agent }) =>
          Effect.gen(function* () {
            const decoded = yield* S.decodeEffect(S.fromJsonString(WireCommand))(raw).pipe(
              Effect.mapError((error) => `invalid forwarded command: ${errorMessage(error)}`),
            );
            // The daemon cannot know a plugin verb's `target` — it holds no
            // registry of its own — so a request reaching a client is where
            // "view commands never run remotely" actually gets enforced.
            if (!app.commands.isRemoteCommand(decoded._tag)) {
              return yield* Effect.fail(
                `command '${decoded._tag}' is a view command, not remotely invocable`,
              );
            }
            const result = yield* app.commands.run(decoded, commandInvocation(source, pane, agent));
            if (result === undefined) {
              options.session.respondCommand(id, undefined);
              return;
            }
            const schema = app.commands.resultSchemaFor(decoded._tag);
            if (schema === undefined) {
              return yield* Effect.fail(
                `command '${decoded._tag}' returned a value but declares no result Schema`,
              );
            }
            const encoded = yield* S.encodeEffect(S.fromJsonString(schema))(result).pipe(
              Effect.mapError(
                (error) => `command '${decoded._tag}' result: ${errorMessage(error)}`,
              ),
            );
            options.session.respondCommand(id, encoded);
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                options.session.respondCommand(
                  id,
                  undefined,
                  typeof error === "string" ? error : errorMessage(error),
                ),
              ),
            ),
          ),
      ),
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
  appOptions: AppOptions,
  spaces: SpaceSet,
  fiberScope: Scope.Closeable,
  runFiber: AppFiberRunner,
  slots: SlotsService,
  contributions: PluginContributions,
  pluginRuntime: PluginRuntime,
  processDisplay: ProcessDisplayService,
  optionsRuntime: Options,
  rootRuntime: RootRuntimeContext,
  externalProviders: {
    readonly slots: ProviderRef<SlotsService>;
    readonly sessionViews: ProviderRef<SessionViewsService>;
    readonly processDisplay: ProviderRef<ProcessDisplayService>;
    readonly layoutKinds: ProviderRef<LayoutKindsService>;
    readonly spawnProviders: ProviderRef<SpawnProvidersService>;
  },
  externalDefaults: {
    readonly slots: SlotsService;
    readonly sessionViews: SessionViewsService;
    readonly processDisplay: ProcessDisplayService;
    readonly layoutKinds: LayoutKindsService;
    readonly spawnProviders: SpawnProvidersService;
  },
): ManagedAppHandle {
  const { renderer, paneHost, config, session, quit } = appOptions;
  /**
   * Run one of the workspace's Effect-returning methods here and now.
   *
   * Commands no longer need this — a CommandSpec's `run` is an Effect, so it
   * yields. What is left are the callers that are not commands and cannot be:
   * boot, and the prompt flows, which are `async` because they await an answer
   * from a Solid signal rather than from Effect.
   */
  const run = <A,>(effect: Effect.Effect<A>): A => Effect.runSyncWith(rootRuntime)(effect);
  const saveConfig = (config: Config): Promise<void> =>
    Effect.runPromiseWith(rootRuntime)(saveConfigEffect(config));

  // Copy goes to the clipboard AND the server's buffer stack — tmux's model,
  // and what makes copy/paste work over ssh, between panes, and from a
  // script: the stack lives beside the daemon's PTYs, so paste needs no
  // attached client. The clipboard keeps its old verdict (a rejected OSC 52
  // is still a rejection); the push is best-effort and fire-and-forget, the
  // same as the clipboard write itself. `target` is vim `"+` (clipboard) vs
  // `"*` (primary selection on X11).
  spaces.onCopy = (text, target = "clipboard") => {
    void Effect.runPromiseWith(rootRuntime)(session.setBuffer(undefined, text)).catch((error) =>
      // @effect-diagnostics-next-line globalConsole:off -- plain render-tree error reporting.
      console.error(`could not push paste buffer: ${String(error)}`),
    );
    return renderer.copyToClipboardOSC52(
      text,
      target === "primary" ? ClipboardTarget.Primary : ClipboardTarget.Clipboard,
    );
  };
  // @effect-diagnostics-next-line globalConsole:off -- plain render-tree error reporting.
  spaces.onCopyError = (error) => console.error(error.message);
  const app = createAppState(spaces);
  const [snapshot, setSnapshot] = createSignal<WorkspaceSnapshot>(session.workspace());
  session.attach.onClose = (error) => {
    // A close carries its own reason in two independent ways: a server-sent
    // protocol error frame (onError, below) or a client-detected transport
    // failure — a bad frame, an unmatched workspace revision, a write that
    // failed — surfaced only here, as `error`. Prefer whichever fires; both
    // beat the generic fallback the panel shows when neither does.
    if (error) setDisconnectReason(error.message);
    setDaemonDisconnected(true);
  };
  // The transport's own explanation for a close, when it has one (an
  // AttachHub eviction sends this before hanging up); onClose still fires
  // right after, since the socket does close either way.
  session.attach.onError = (message) => setDisconnectReason(message);

  /**
   * Keyboard copy mode: the pane's read-only review layer. One instance for the
   * whole app, entered on whatever pane is focused. The mode renders through the
   * pane's existing selection machinery and copies through the same chain the
   * mouse drag does, so nothing here owns a second copy path.
   */
  const copyMode = new CopyMode();
  copyMode.onStateChange = () => app.refresh();
  // Filled once contribution tables exist; plugin.inspect reads it lazily.
  let inspectCatalog: InspectCatalog | undefined;
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
        return Effect.runPromiseWith(rootRuntime)(
          projectWorkspace(spaces, model, session.backend()),
        );
      })
      .then(() => {
        if (model.revision <= projectedRevision) return;
        projectedRevision = model.revision;
        setSnapshot(structuredClone(model));
        installModelCallbacks();
        app.refresh();
        if (model.spaces.length === 0) shutdown();
        // A component session can arrive from any client — a daemon-side
        // plugin command, another attached client, a resumed reload — not
        // only from this client's own runPanelCommand. Every broadcast
        // model update is the one place all of those converge, so this is
        // where a still-unspawned component agent gets its worker started;
        // resumePending is idempotent per session id.
        return pluginRuntime.resumePending
          ? Effect.runPromiseWith(rootRuntime)(pluginRuntime.resumePending(model))
          : undefined;
      })
      .catch((error) =>
        // @effect-diagnostics-next-line globalConsole:off -- plain render-tree error reporting.
        console.error(`could not project workspace revision ${model.revision}: ${String(error)}`),
      );
    return projection;
  };
  // Same as project, but ignores the revision gate — plugins that register
  // layout-kind renderers after the first paint need a remount without a
  // daemon generation bump.
  pluginRuntime.remountLayouts = () => {
    if (disposed) return Promise.resolve();
    const model = session.workspace();
    // Chain behind any in-flight projection so we don't race two mounts, then
    // remount regardless of revision — the point is the kind renderer map
    // changed, not the workspace.
    projection = projection
      .then(() =>
        Effect.runPromiseWith(rootRuntime)(projectWorkspace(spaces, model, session.backend())),
      )
      .then(() => {
        projectedRevision = Math.max(projectedRevision, model.revision);
        setSnapshot(structuredClone(model));
        installModelCallbacks();
        app.refresh();
      })
      .catch((error) =>
        // @effect-diagnostics-next-line globalConsole:off -- plain render-tree error reporting.
        console.error(`could not remount layouts after plugin load: ${String(error)}`),
      );
    return projection;
  };
  runFiber("workspace-models", runModelProjections(session.models, project));
  const workspaceContext = () => {
    const focused = spaces.activeWindow?.focused;
    const base = {
      size: {
        cols: Math.max(1, paneHost.width),
        rows: Math.max(1, paneHost.height),
      },
      shell: [
        // @effect-diagnostics-next-line processEnv:off -- render-tree workspace context fallback.
        resolveOptions(configState().options)["behaviour.shell"] || process.env.SHELL || "bash",
      ],
      cwd: spaces.active?.dir ?? process.cwd(),
      // Attached client's default source. CurrentInvocation overrides source
      // (and pane/agent) when a handler forwards under an existing call.
      source: "socket" as const,
      blockedAgents: spaces.allSessions
        .filter((session) => session.state === ProcessState.Blocked)
        .map((session) => session.id),
    };
    // So editor.open / agent.new can replace the focused leaf the same way a
    // shell CLI does via AMUX_PANE_ID. Absent when nothing is focused.
    return focused != null ? { ...base, pane: focused.id } : base;
  };

  const callerWorkspaceContext = Effect.gen(function* () {
    const inv = yield* Effect.serviceOption(CurrentInvocation);
    const base = workspaceContext();
    return Option.match(inv, {
      onNone: () => base,
      onSome: (i) => {
        if (i.pane !== undefined && i.agent !== undefined)
          return { ...base, source: i.source, pane: i.pane, agent: i.agent };
        if (i.pane !== undefined) return { ...base, source: i.source, pane: i.pane };
        if (i.agent !== undefined) return { ...base, source: i.source, agent: i.agent };
        return { ...base, source: i.source };
      },
    });
  });

  const runPanelCommand = <T extends CommandTag>(
    value: Extract<Command, { _tag: T }>,
    input?: string,
  ): Effect.Effect<CommandResult<T>, CommandError> =>
    Effect.gen(function* () {
      const context = yield* callerWorkspaceContext;
      const output = yield* session
        .runWorkspace(value, {
          ...context,
          input,
        })
        .pipe(
          Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
          Effect.tap(({ snapshot }) => Effect.promise(() => project(snapshot))),
          Effect.tap(({ snapshot }) => pluginRuntime.resumePending?.(snapshot) ?? Effect.void),
        );
      return yield* decodeCoreCommandResult(value._tag, output.result);
    });

  const runCommand = <T extends CommandTag>(
    value: Extract<Command, { _tag: T }>,
    input?: string,
  ): Effect.Effect<CommandResult<T>, CommandError> =>
    runCommandByTarget(
      value,
      () => runPanelCommand(value, input),
      () =>
        Effect.gen(function* () {
          const context = yield* callerWorkspaceContext;
          const result = yield* session
            .run(value, context)
            .pipe(Effect.mapError((error) => new CommandError({ message: errorMessage(error) })));
          return yield* decodeCoreCommandResult(value._tag, result);
        }),
    );

  /** Push the live pane-host size through ensureVisible so niri column widths
   *  rescale after a sidebar toggle or terminal resize (basisCols). */
  function syncScrollViewport() {
    const pane = spaces.activeWindow?.focused;
    if (!pane) return;
    void Effect.runPromise(
      runCommand(command("pane.select", { pane: pane.id })).pipe(Effect.catch(() => Effect.void)),
    );
  }

  // A plugin verb's daemon-side registration can target "workspace" (needs
  // size/shell/cwd to mutate the model, e.g. spawning an agent's pane) or
  // "session" (ignores it). That target lives only in the daemon's command
  // table, invisible from here, so this always attaches the panel's live
  // context — a "session"-target command simply never reads it.
  const runRegisteredCommand = (
    value: RegisteredCommand,
    input?: string,
  ): Effect.Effect<unknown, CommandError> =>
    Effect.gen(function* () {
      const context = yield* callerWorkspaceContext;
      return yield* session.runWorkspace(value, { ...context, input }).pipe(
        Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
        Effect.tap(({ snapshot }) => Effect.promise(() => project(snapshot))),
        Effect.tap(({ snapshot }) => pluginRuntime.resumePending?.(snapshot) ?? Effect.void),
        Effect.map(({ result }) => result),
      );
    });

  const [configState, setConfigState] = createSignal<Config>(config);

  /** Names a plugin has claimed through `registerOption`, section-sorted and
   *  rendered by the settings window the same way a core option is. */
  const optionContributions = contributions.table<OptionSpec>();
  /** Values a plugin has contributed to an existing enum option's closed
   *  choice, keyed by "option::value" so two plugins naming different values
   *  for the same option never collide — only two plugins naming the *same*
   *  value do, the same conflict a slot collision is. */
  const enumValueContributions = contributions.table<EnumValueRegistration>();
  const optionsService = scopedRegistry(
    {
      get: (name: string) => optionContributions.get(name),
      all: () => optionContributions.all(),
      registerEnumValue: (registration: EnumValueRegistration) =>
        Effect.gen(function* () {
          const owner = yield* CurrentPlugin;
          const scope = yield* Scope.Scope;
          const dispose = enumValueContributions.add(
            owner,
            `${registration.option}::${registration.value}`,
            registration,
          );
          yield* Scope.addFinalizer(scope, Effect.sync(dispose));
        }),
      enumValues: (name: string) =>
        enumValueContributions
          .all()
          .filter((entry) => entry.value.option === name)
          .map((entry) => entry.value.value),
    },
    (owner, [name, spec]: readonly [string, OptionSpec]) => {
      if (optionSpec(name)) throw new Error(`option '${name}' is a built-in option`);
      return optionContributions.add(owner, name, spec);
    },
  );
  const optionsProvider = providerRef<OptionsService>(optionsService);

  /** Every core option resolved against its declared default — what the app
   *  reads for its own chrome. The config itself holds only what the user
   *  changed. Plugin-registered options are not in here: they have no fixed
   *  key set to iterate, so they are resolved on demand by name instead. An
   *  enum option's plugin-contributed values (a tiling-algorithm plugin's own
   *  id, say) extend its closed choice here the same way they do everywhere
   *  else this app reads or cycles one. */
  const options = createMemo(() =>
    resolveOptions(
      configState().options,
      new Map(optionNames.map((name) => [name, optionsService.enumValues(name)])),
    ),
  );

  /** A core or plugin-registered option's declaration, by name. */
  function specFor(name: string): OptionSpec | undefined {
    return optionSpec(name) ?? optionsProvider.value.get(name);
  }

  /** A core or plugin-registered option's current value, resolved the same
   *  way the core `options` memo resolves one — default unless the config has
   *  a delta for it. */
  function optionValue(name: string, spec: OptionSpec): OptionValue {
    return (
      coerceOption(spec, configState().options[name], optionsService.enumValues(name)) ??
      spec.default
    );
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
    changeOption(
      name,
      adjustedValue(spec, optionValue(name, spec), by, optionsService.enumValues(name)),
    );
  }

  /** Where every panel on screen is registered. See panelGroups below. */

  const [overlay, setOverlay] = createSignal<Overlay>("none");
  // The raw compiled chord parts for which-key matching (not showcmd layout).
  const [pendingParts, setPendingParts] = createSignal<readonly { display: string }[]>([]);
  const [showcmdEpoch, setShowcmdEpoch] = createSignal(0);
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
  const settingsService = scopedRegistry(
    { all: () => settingsSectionTable.all().map((entry) => entry.value) },
    (owner, section: PluginSettingsSection) => settingsSectionTable.add(owner, section.id, section),
  );
  const settingsProvider = providerRef<SettingsService>(settingsService);
  const pluginSettings = () => settingsProvider.value.all();
  /** True while the keybind editor is waiting for the keystroke to record. */
  const [capturing, setCapturing] = createSignal(false);
  const [conflicts, setConflicts] = createSignal<Conflict[]>([]);
  const [keybindPicker, setKeybindPicker] = createSignal<KeybindPickerView | null>(null);
  const [paletteQuery, setPaletteQuery] = createSignal("");
  const [paletteSelected, setPaletteSelected] = createSignal(0);
  /** The keybind tab's scroll container, so ↑↓ can drive a list that is much
   *  longer than the window. */
  let keybindList: ScrollBoxRenderable | null = null;
  /** Command errors logged since the console was last opened. */
  const [unseenErrorCount, setUnseenErrorCount] = createSignal(0);
  const [inspectLines, setInspectLines] = createSignal<readonly string[] | null>(null);
  // Logs into OpenTUI's console capture; a footer marker shows until the user
  // opens the console. The console never opens on its own.
  function showCommandError(message: string) {
    // @effect-diagnostics-next-line globalConsole:off -- feeds the OpenTUI console overlay.
    console.error(message);
    setInspectLines(null);
    setUnseenErrorCount((count) => count + 1);
  }
  /** OpenTUI TerminalConsole.toggle — show when closed, hide when focused. */
  function toggleCommandConsole() {
    if (!renderer.console.visible) {
      setUnseenErrorCount(0);
      renderer.consoleMode = "console-overlay";
    }
    renderer.console.toggle();
  }
  const [daemonDisconnected, setDaemonDisconnected] = createSignal(false);
  // Set only when the attach transport itself explained why it closed (e.g.
  // AttachHub evicting a slow/overflowing client) — distinct from the daemon
  // process actually dying, which this client cannot observe directly.
  const [disconnectReason, setDisconnectReason] = createSignal<string | null>(null);
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
          const process = processDisplay.display({
            session: session.id,
            state: session.state,
            exitCode: session.exitCode,
            detached: session.detached,
            title: session.title,
          });
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
            sessionKind: session.kind,
            title: process.title ?? session.title,
            foregroundCommand: session.foregroundCommand,
            viewers: session.viewers,
            unseen: session.unseen,
            scrolled: session.scrolled,
            exited: session.exited,
          });
        }
      }
    }

    return {
      rows,
      spaceCount: spaces.spaces.length,
    };
  });
  const onResize = (width: number, height: number) => {
    setSize({ width, height });
    // paneHost's Yoga size updates with the terminal; nudge the scroll strip
    // so basisCols tracks the new cell count.
    queueMicrotask(() => syncScrollViewport());
  };
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
    return Effect.callback<string[] | null>((resume) => {
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
    yield* commands.run(command("space.new", args), keyInvocation());
  });

  const promptRenameSpace = Effect.gen(function* () {
    const space = spaces.active;
    if (!space) return;
    const answers = yield* ask("Rename space", [{ label: "Name", value: space.name }]);
    if (!answers) return;
    yield* commands.run(
      command("space.rename", { space: space.id, name: answers[0] ?? "" }),
      keyInvocation(),
    );
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
    yield* commands.run(command("pane.move", { space: wanted.id }), keyInvocation());
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
      keyInvocation(),
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
    return settingsFields(allOptions(), settingsSection(), optionsProvider.value.all())[
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
        list.map((binding) => formatSequence(binding.sequence, bindings.leaders())),
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
    ].filter((key) => !used.has(`${formatKey(bindings.prefix())} ${key}`));
  }

  function openKeybindPicker(add: boolean) {
    const target = keybindTarget();
    // Remap surface: include inactive PANE-band verbs the runnable palette hides.
    const entries = sortKeybindEntries(
      filterPaletteEntries(allPaletteEntries(), "", { includeHidden: true }),
    );
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
      if (event.name !== "escape") setKeys({ ...configState().keys, prefix: key });
    });
  }

  function captureLeader() {
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
      const defaults = keysFor(spec, {
        prefix: DEFAULT_PREFIX,
        leader: DEFAULT_LEADER,
        bindings: {},
      });
      const token = defaults.some((binding) => binding.startsWith("<leader>"))
        ? "<leader>"
        : "<prefix>";
      const next = `${token}${key}`;
      const compiled = bindings.keymap.parseKeySequence(next);
      const display = formatSequence(compiled, bindings.leaders());
      const active = bindings.keymap.getCommandBindings({
        visibility: "registered",
        commands: registeredBindings().map((candidate) => candidate.name),
      });
      const owner = [...active].find(([, list]) =>
        list.some((binding) => formatSequence(binding.sequence, bindings.leaders()) === display),
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
      return setKeys({ ...keys, prefix: DEFAULT_PREFIX });
    }
    if (command === LEADER_TARGET) {
      if (unbind) return;
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
   * Find a live pane by id across every space/window. Used by remote
   * `pane.capture` / `pane.send-keys` when the daemon routed a client-only
   * target here.
   */
  function findPane(paneId: string): Pane | null {
    for (const space of spaces.spaces) {
      for (const window of space.windows) {
        const pane = window.panes.find((candidate) => candidate.id === paneId);
        if (pane) return pane;
      }
    }
    return null;
  }

  /**
   * Serialize a plugin pane's current OpenTUI content as plain text. The
   * daemon cannot see Solid pixels — only this client has the frame.
   */
  function capturePluginPane(pane: Pane): string {
    const rect = pane.view.contentRect;
    return captureFrameRect(renderer.currentRenderBuffer, rect);
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
    // @effect-diagnostics-next-line globalDate:off -- capture names are UI-facing filesystem labels.
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
                      error: `could not save capture to ${path}: ${errorMessage(error)}`,
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
          void Effect.runPromiseWith(rootRuntime)(session.pasteBuffer(name, pane.session.id)).catch(
            // @effect-diagnostics-next-line globalConsole:off -- plain render-tree error reporting.
            (error) => console.error(`could not paste buffer '${name}': ${String(error)}`),
          );
        }
        setChooseView(null);
      },
      onDelete: (name) => {
        void Effect.runPromiseWith(rootRuntime)(
          session.deleteBuffer(name).pipe(Effect.andThen(session.listBuffers)),
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
          .catch((error) => {
            // @effect-diagnostics-next-line globalConsole:off -- plain render-tree error reporting.
            console.error(`could not delete buffer '${name}': ${String(error)}`);
          });
      },
      onClose: () => setChooseView(null),
    });
  }

  /**
   * The pane send-keys targets: the focused pane, or the sidebar's selected
   * agent when nothing is focused. Selected agents are revealed first — a row is
   * only a "selected pane" once it has a viewport keystrokes can land in.
   */
  function sendKeysTarget(paneId?: string, dispatch = false): SendTarget | null {
    let targetWindow = spaces.activeWindow;
    let target = targetWindow?.focused ?? null;
    if (paneId !== undefined) {
      target = null;
      for (const space of spaces.spaces) {
        for (const window of space.windows) {
          const pane = window.panes.find((candidate) => candidate.id === paneId);
          if (!pane) continue;
          targetWindow = window;
          target = pane;
          break;
        }
        if (target) break;
      }
    }
    if (target) {
      const direct: SendTarget = {
        key: (event) => (targetWindow?.sync ? targetWindow.key(event) : target.handleKey(event)),
        describe: () => target.session?.title || "pane",
      };
      dispatchTarget ??= createKeyDispatcher(dispatchSentKey, bindings.activeCommand);
      return dispatch ? dispatchTarget(direct) : direct;
    }
    return null;
  }

  function dispatchSentKey(event: KeyEvent): boolean {
    renderer.keyInput.emit("keypress", event);
    return event.defaultPrevented;
  }
  let dispatchTarget: ((target: SendTarget) => SendTarget) | null = null;

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
          Effect.gen(function* () {
            const context = yield* callerWorkspaceContext;
            return yield* session
              .run(command("pane.send-keys", { keys: values[0] ?? "" }), context)
              .pipe(Effect.mapError((error) => new CommandError({ message: errorMessage(error) })));
          }).pipe(Effect.provideService(CurrentInvocation, keyInvocation())),
          showCommandError,
          rootRuntime,
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
    "pane.open-plugin": runCommand,
    "process-plugin.pane.open": runCommand,
    "process-plugin.action.invoke": runCommand,
    "pane.next": runCommand,
    "pane.last": runCommand,
    "pane.focus": runCommand,
    "pane.select": runCommand,
    "pane.set-descriptor": runCommand,
    "pane.resize": runCommand,
    "pane.resize-divider": runCommand,
    "pane.set-size": runCommand,
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
    "pane.send-keys": ({ keys, pane, dispatch }) =>
      Effect.gen(function* () {
        const inv = yield* CurrentInvocation;
        const id = pane ?? inv.pane;
        if (id === undefined) return yield* new CommandError({ message: "no pane to send to" });
        const target = sendKeysTarget(id, dispatch === true);
        if (!target) return yield* new CommandError({ message: "no pane to send to" });
        const error = sendKeys(target, keys, parseKeyStrokes.bind(null, bindings.keymap));
        if (error) return yield* new CommandError({ message: error.message });
      }),
    "pane.capture": ({ session, pane }) =>
      Effect.gen(function* () {
        const inv = yield* CurrentInvocation;
        // Human keybind only: remote/CLI paths must arrive with a pinned pane
        // (or fail in the daemon). Inferring overlay from missing args would
        // open a capture UI on the attached human for a failed CLI call.
        if (session === undefined && pane === undefined && inv.source === "key") {
          openCapture();
          return "";
        }
        if (pane === undefined) return yield* new CommandError({ message: "no pane to capture" });
        const target = findPane(pane);
        if (!target) return yield* new CommandError({ message: `pane '${pane}' not found` });
        if (target.session !== null) return captureSpan(target.session.term, "visible");
        if (!(target instanceof ComponentPane))
          return yield* new CommandError({ message: `pane '${pane}' has no capturable content` });
        return capturePluginPane(target);
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
      session.listBuffers.pipe(
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
        const buffers = yield* session.listBuffers.pipe(
          Effect.mapError((error) => new CommandError({ message: errorMessage(error) })),
        );
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
    "workspace.rebuild-tiling": runCommand,
    "window.list": runCommand,

    notify: runCommand,
    "session.kill": runCommand,
    "session.message": runCommand,
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
        const coerced = coerceOption(spec, value, optionsService.enumValues(option));
        if (coerced === undefined) {
          return yield* new CommandError({
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- this formats an already-validated command value for a UI error.
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
        if (option === "sidebar.open") {
          // Sidebar width changes paneHost via Yoga after this turn; wait one
          // frame so workspaceContext.size matches the new host before we ask
          // niri to rescale column widths.
          yield* Effect.sleep("16 millis");
          syncScrollViewport();
        }
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
    "app.console": () => Effect.sync(toggleCommandConsole),
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
        const strokes = parseKeyStrokes(bindings.keymap, "<prefix>");
        if (!strokes) return;
        sendKeys(sendKeysTarget()!, "<prefix>", () => strokes);
      }),
    // Through the daemon: host materializes / prepares / publishes; every
    // attached client's UI half follows PluginPublications.
    "plugin.reload": runCommand,
    "plugin.eval": runCommand,
    "plugin.promote": runCommand,
    "plugin.inspect": (query) =>
      Effect.suspend(() => {
        if (!inspectCatalog)
          return Effect.fail(new CommandError({ message: "plugin runtime is unavailable" }));
        const result = inspect(inspectCatalog, query);
        if (!result.found && result.description?.startsWith("plugin.inspect "))
          return Effect.fail(new CommandError({ message: result.description }));
        return Effect.succeed(result);
      }),
    "app.describe-key": (query) =>
      Effect.sync(() => {
        if (!inspectCatalog) {
          showCommandError("plugin runtime is unavailable");
          return;
        }
        const hasSubject =
          (query.command !== undefined && query.command !== "") ||
          (query.binding !== undefined && query.binding !== "") ||
          (query.key !== undefined && query.key !== "") ||
          (query.pane !== undefined && query.pane !== "") ||
          (query.plugin !== undefined && query.plugin !== "");
        const resolved = hasSubject
          ? query
          : (() => {
              const pane = spaces.activeWindow?.focused?.id;
              return pane !== undefined ? { pane } : undefined;
            })();
        if (resolved === undefined) {
          showCommandError("no focused pane to describe");
          return;
        }
        const result = inspect(inspectCatalog, resolved);
        if (!result.found && result.description?.startsWith("plugin.inspect ")) {
          showCommandError(result.description);
          return;
        }
        setInspectLines(formatInspectResult(result));
      }),
    "plugin.enable": runCommand,
    "plugin.disable": runCommand,
    "app.quit": () => Effect.sync(shutdown),
  };

  const focusedPaneId = (): string | undefined => spaces.activeWindow?.focused?.id;

  const keyInvocation = (): CommandInvocation => commandInvocation("key", focusedPaneId());

  const rawCommands = makeCommands(handlers, {
    realmForPane: (paneId) => {
      const host = pluginRuntime.host;
      if (host === undefined) return NO_REALM;
      return realmOf(paneRealm(paneId), host.realmContext(paneRealm(paneId)));
    },
  });
  const commandsService = scopedRegistry(
    {
      run: rawCommands.run,
      withRealm: rawCommands.withRealm,
      list: rawCommands.list,
      isWorkspaceCommand: rawCommands.isWorkspaceCommand,
      isRemoteCommand: rawCommands.isRemoteCommand,
      resourcesFor: rawCommands.resourcesFor,
      resultSchemaFor: rawCommands.resultSchemaFor,
    },
    (owner, registration: CommandRegistration) =>
      rawCommands.registerCommand(
        owner.id,
        registration.verb,
        registration.fields,
        registration.meta,
        registration.resources,
        registration.handler,
        registration.result,
      ),
  );
  const commandsProvider = providerRef<CommandsService>(commandsService);
  const commands = commandsProvider.value;
  runProjectedCommand = (value) =>
    runDetached(value._tag, commands.run(value, keyInvocation()), showCommandError, rootRuntime);

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
      run: Effect.suspend(() => {
        // Client-target verbs must reach runRemote so the gate sees them; the
        // daemon returns the work on this attach connection via runOnClient.
        // View stays local. Workspace/session/server handlers already forward.
        if (meta.target === "client") {
          return Effect.gen(function* () {
            const context = yield* callerWorkspaceContext;
            return yield* session
              .run(cmd, context)
              .pipe(Effect.mapError((error) => new CommandError({ message: errorMessage(error) })));
          }).pipe(Effect.provideService(CurrentInvocation, keyInvocation()));
        }
        return commands.run(cmd, keyInvocation());
      }),
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
    bind("pane.split-row", ["<prefix>|", "<prefix>\\"], command("pane.split", { axis: "row" }), {
      desc: "split left/right",
    }),
    bind("pane.split-column", "<prefix>-", command("pane.split", { axis: "column" }), {
      desc: "split top/bottom",
    }),
    bind("pane.next", "<prefix>o", command("pane.next"), { desc: "next pane" }),
    // tmux's last-pane: toggle to the pane you were just on.
    bind("pane.last", "<prefix>;", command("pane.last"), {
      desc: "toggle to the last-focused pane",
    }),
    // Directional focus, tmux's select-pane — but with vim hjkl letters so the
    // four directions stay symmetric. (tmux itself keeps ^a l for last-window;
    // we put that on <prefix>L below so pane navigation can own the letter.)
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
        [`<prefix>${letter}`, `<prefix>${direction}`],
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
      bind(`pane.resize-${direction}`, `<prefix>${key}`, command("pane.resize", { direction }), {
        desc: `resize pane ${direction}`,
      }),
    ),
    // Vim CTRL-W window table under the mux prefix. Counts while pending
    // (`^S ^W 80|`) are ChordMatcher grammar, not separate bindings.
    // Cite: neovim window_commands; chord-matcher + key-invocation counts.
    ...(
      [
        ["left", "h"],
        ["down", "j"],
        ["up", "k"],
        ["right", "l"],
      ] as const
    ).map(([direction, letter]) =>
      bind(
        `pane.window-focus-${direction}`,
        `<prefix>ctrl+w${letter}`,
        command("pane.focus", { direction }),
        { desc: `window: focus ${direction}`, group: "window" },
      ),
    ),
    bind("pane.window-next", "<prefix>ctrl+ww", command("pane.next"), {
      desc: "window: next pane",
      group: "window",
    }),
    bind("pane.window-prev", "<prefix>ctrl+wshift+w", command("pane.last"), {
      desc: "window: last pane",
      group: "window",
    }),
    bind("pane.window-close", "<prefix>ctrl+wc", command("pane.close"), {
      desc: "window: close pane",
      group: "window",
    }),
    bind("pane.window-close-q", "<prefix>ctrl+wq", command("pane.close"), {
      desc: "window: close pane",
      group: "window",
      hidden: true,
    }),
    bind("pane.window-split-row", "<prefix>ctrl+wv", command("pane.split", { axis: "row" }), {
      desc: "window: split left/right",
      group: "window",
    }),
    bind("pane.window-split-column", "<prefix>ctrl+ws", command("pane.split", { axis: "column" }), {
      desc: "window: split top/bottom",
      group: "window",
    }),
    bind("pane.window-zoom", "<prefix>ctrl+wo", command("pane.zoom"), {
      desc: "window: zoom pane",
      group: "window",
    }),
    bind("pane.window-break", "<prefix>ctrl+wshift+t", command("pane.break"), {
      desc: "window: break to new window",
      group: "window",
    }),
    bind(
      "pane.window-balance",
      "<prefix>ctrl+w=",
      command("window.select-layout", { preset: "tiled" }),
      { desc: "window: balance panes", group: "window" },
    ),
    {
      name: "pane.window-width",
      key: "<prefix>ctrl+w|",
      desc: "window: set width (count = columns)",
      group: "window",
      run: Effect.gen(function* () {
        const inv = yield* KeyInvocation;
        const cells = inv.data.count;
        yield* commands.run(
          command(
            "pane.set-size",
            cells === undefined ? { axis: "cols" } : { axis: "cols", cells },
          ),
          keyInvocation(),
        );
      }),
    },
    {
      name: "pane.window-height",
      key: "<prefix>ctrl+w_",
      desc: "window: set height (count = rows)",
      group: "window",
      run: Effect.gen(function* () {
        const inv = yield* KeyInvocation;
        const cells = inv.data.count;
        yield* commands.run(
          command(
            "pane.set-size",
            cells === undefined ? { axis: "rows" } : { axis: "rows", cells },
          ),
          keyInvocation(),
        );
      }),
    },
    bind("pane.zoom", "<prefix>z", command("pane.zoom"), {
      desc: "zoom the focused pane (Z in the tab)",
    }),
    bind("pane.float", "<prefix>f", command("pane.float"), {
      desc: "float the focused pane over the others, or put it back",
    }),
    bind("pane.dock-left", undefined, command("pane.dock-left")),
    bind("pane.dock-right", undefined, command("pane.dock-right")),
    bind("pane.dock-top", undefined, command("pane.dock-top")),
    bind("pane.dock-bottom", undefined, command("pane.dock-bottom")),
    bind("pane.undock", undefined, command("pane.undock")),
    bind("pane.swap-previous", "<prefix>{", command("pane.swap", { to: "previous" }), {
      desc: "swap pane with the previous one",
    }),
    bind("pane.swap-next", "<prefix>}", command("pane.swap", { to: "next" }), {
      desc: "swap pane with the next one",
    }),
    bind("pane.close", "<prefix>x", command("pane.close"), {
      desc: "close pane (stops its backend if it has no other view)",
    }),
    // shift+c: plain ^a c is new window, and this is near pane.close's ^a x.
    bind("pane.capture", "<prefix>shift+c", command("pane.capture"), {
      desc: "capture the focused pane (s saves)",
    }),
    bind("pane.copy-mode", "<prefix>[", command("pane.copy-mode"), {
      desc: "copy mode: review pane history (v selects, y copies)",
    }),
    // tmux's own paste-buffer and choose-buffer bindings: ^a ] pastes the top
    // of the server-side stack into the focused pane, ^a = picks one.
    bind("buffer.paste", "<prefix>]", command("buffer.paste"), {
      desc: "paste the top paste buffer into the focused pane",
    }),
    bind("buffer.choose", "<prefix>=", command("buffer.choose"), {
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
    bind("pane.break", "<prefix>!", command("pane.break")),
    bindPrompt("pane.move", "<prefix>shift+m", promptMovePane, "move pane to another space"),

    // Windows.
    bind("window.new", "<prefix>c", command("window.new")),
    bind("window.next", "<prefix>n", command("window.next")),
    bind("window.previous", "<prefix>p", command("window.previous")),
    // tmux's last-window. shift+l (not bare "L": capitals compile as the
    // lowercase letter) so pane focus can keep hjkl.
    bind("window.last", "<prefix>shift+l", command("window.last"), {
      desc: "toggle to the last window",
    }),
    bindPrompt("window.rename", "<prefix>,", promptRenameWindow, "rename window"),
    bind("window.close", "<prefix>&", command("window.close"), {
      desc: "kill window and its agents",
    }),
    // tmux's next-layout, on tmux's own binding.
    bind("window.next-layout", "<prefix>space", command("window.next-layout")),
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
    bind("window.synchronize-panes", "<prefix>y", command("window.synchronize-panes")),
    // 1..9 select by the window's own number, which is why that number is stable
    // rather than a position in the list. Nine bindings supplying an argument to
    // one command, which is exactly tmux's `bind-key 1 select-window -t 1`.
    ...Array.from({ length: 9 }, (_, i) =>
      bind(
        `window.select-${i + 1}`,
        `<prefix>${i + 1}`,
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
    bind("session.kill", "<prefix>shift+k", command("session.kill"), {
      desc: "stop the focused agent",
    }),
    bind("session.restart", "<prefix>shift+r", command("session.restart"), {
      desc: "restart the focused agent",
    }),

    // Spaces.
    bindPrompt("space.new", "<prefix>s", promptNewSpace),
    bindPrompt("space.rename", "<prefix>r", promptRenameSpace, "rename space"),
    bind("space.next", "<prefix>)", command("space.next")),
    bind("space.previous", "<prefix>(", command("space.previous")),
    bind("space.close", undefined, command("space.close")),

    // App.
    // A binding names the option; there is no `sidebar.toggle` verb behind it.
    // The name is still the binding's identity, so the keybind editor and the
    // palette read exactly as they did when it was a command of its own.
    bind("sidebar.toggle", "<prefix>b", command("config.toggle", { name: "sidebar.open" }), {
      desc: "toggle sidebar",
      group: "global",
    }),
    bind(
      "sidebar.toggle-agents-only",
      undefined,
      command("config.toggle", { name: "sidebar.agentsOnly" }),
      { desc: "show only panes running agent CLIs", group: "global" },
    ),
    // `<prefix>/` is reserved for editor.find-file (project picker). Keep help on `?` only.
    bind("app.help", "<prefix>?", command("app.help")),
    // OpenTUI's console demo uses bare backtick; under the mux prefix so a
    // typing shell never sees it. Key event name is "`", not the token
    // "backquote" (parse.keypress), so the binding must use the literal.
    bind("app.console", "<prefix>`", command("app.console")),
    // Near help: ownership / describe-key for the focused pane (or a named subject).
    // shift+k, not "K": capitals collapse to the lowercase stroke (see app.settings).
    bind("app.describe-key", "<prefix>shift+k", command("app.describe-key"), {
      desc: "describe focused pane / binding ownership",
    }),
    bind("app.command-palette", "<prefix>:", command("app.command-palette")),
    // shift+s, not "S": a bare capital compiles to the same sequence as the
    // lowercase one, so this was silently shadowed by space.new's ^a s.
    bind("app.settings", "<prefix>shift+s", command("app.settings")),
    // The prefix twice, written as the token so it follows a rebind — and sent
    // as whatever bytes that prefix actually produces. Not offered in the
    // editor: its sequence is the prefix, and the prefix row already edits that.
    bind("app.send-prefix", "<prefix><prefix>", command("app.send-prefix"), {
      fixed: true,
    }),
    bind("app.quit", "<prefix>q", command("app.quit")),
  ];

  /**
   * Keys not claimed by a binding belong to the child — except while a modal or
   * the sidebar has focus. Returns whether the app consumed the key; see the
   * note on preventDefault in bindings.ts.
   */
  function onUnhandled(event: KeyEvent): boolean {
    // Every registered context gets a shot, highest priority band first
    // (overlay, then app-mode — copy mode today — CONTEXT_PRIORITY in
    // key-context.ts). The pane is the fallback below every context, not one
    // of them: it decides what an unbound key means, because that depends on
    // what fills it — a terminal wants the bytes a child would have read, a
    // component wants the event left alone for the renderable holding focus.
    const contexts = contextsProvider.value.all();
    if (resolveUnhandled(contexts, event)) return true;
    // Overlay `handle` returning false means "leave it for the focused
    // input", not "try the PTY next" — see overlayBlocksPane.
    if (overlayBlocksPane(contexts)) return false;
    return activeWin()?.key(event) ?? false;
  }

  /** Write the config file. Answers with the failure message, because the two
   *  callers show it in different places: the settings window has an error line,
   *  a panel that saves has only the command-error banner. */
  // @effect-diagnostics-next-line asyncFunction:off -- Solid prompt flow awaits a plain render-tree answer.
  async function persistConfig(): Promise<string | null> {
    try {
      await saveConfig(configState());
      setSettingsDirty(false);
      return null;
    } catch (error) {
      return `could not save settings: ${errorMessage(error)}`;
    }
  }

  // @effect-diagnostics-next-line asyncFunction:off -- Solid settings flow is intentionally plain async.
  async function saveSettings() {
    setSettingsError((await persistConfig()) ?? "");
  }

  function saveOptions() {
    void persistConfig().then((failure) => {
      if (failure) showCommandError(failure);
    });
  }

  const rawBindings = createBindings(renderer, [], {
    keys: config.keys,
    onUnhandled,
    onError: showCommandError,
    runtime: rootRuntime,
    // Focused pane id for the key invocation; Realm comes from commands.withRealm.
    pane: focusedPaneId,
    withRealm: (...args) => commands.withRealm(...args),
  });
  // Sticky minimode: after `^S ^W`, bare h/j/|/… keep firing window maps until
  // Escape. Same ChordMatcher API the editor uses for a future sticky `g`.
  // Cite: chord-matcher.ts ChordMode; hydra.nvim.
  rawBindings.chords.registerMode({
    id: "amux.window",
    strokes: ["<prefix>", "ctrl+w"],
    desc: "window",
  });
  setConflicts(rawBindings.conflicts());
  const bindingTable = contributions.table<CommandSpec>();
  const [registeredBindings, setRegisteredBindings] = createSignal<readonly CommandSpec[]>([]);
  // Bindings reach the keymap through an effect rather than a call in
  // `registerBinding`, because a plugin's bindings also appear and disappear
  // when the host commits or retires the instance that registered them, and
  // nobody calls `registerBinding` at that moment.
  createEffect(() => {
    const next = bindingTable.all().map((entry) => entry.value);
    setRegisteredBindings(next);
    setConflicts(rawBindings.setCommands(next));
  });
  // The built-in commands arrive through this same door, registered by the
  // `amux.commands` entry. Core holds no reserved names: two plugins claiming
  // one binding is a conflict `findConflicts` reports, not an error here.
  const registerBinding = (owner: PluginInstance, binding: CommandSpec) =>
    bindingTable.add(owner, binding.name, binding);
  const bindingsService = scopedRegistry(rawBindings, registerBinding);
  const bindingsProvider = providerRef<BindingsService>(bindingsService);
  const bindings = bindingsProvider.value;

  // The contexts table: a plugin and core register into it exactly like
  // bindings above. onUnhandled resolves every tier against it
  // (`resolveUnhandled`, key-context.ts) except the pane, which is the
  // fallback beneath every context rather than one of them.
  const contextTable = contributions.table<ContextSpec>();
  const registerContext = (owner: PluginInstance, context: ContextSpec) =>
    contextTable.add(owner, context.id, context);
  const contexts = () => contextTable.all().map((entry) => entry.value);
  const contextsService = scopedRegistry(
    { all: contexts, conflicts: () => findContextPriorityConflicts(contexts()) },
    registerContext,
  );
  const contextsProvider = providerRef<ContextsService>(contextsService);

  inspectCatalog = {
    bindings: () => bindingTable.all(),
    contexts: () => contextTable.all(),
    paneViewOwner: (paneType) => externalProviders.sessionViews.value.ownerOf(paneType),
    commandMeta: (tag) => {
      if (Object.hasOwn(COMMAND_META, tag)) return COMMAND_META[tag as keyof typeof COMMAND_META];
      return commands.list().find((meta) => meta.name === tag);
    },
    pluginStatus: (id) => pluginRuntime.host?.status().find((status) => status.id === id),
    pluginGeneration: (id) => pluginRuntime.host?.generation(id),
    pluginSource: (id) => pluginRuntime.uiSource?.(id),
    paneContent: (paneId) => {
      for (const space of session.workspace().spaces) {
        for (const window of space.windows) {
          const pane = layoutRefs(window.layout).find((candidate) => candidate.id === paneId);
          if (pane) return pane.content;
        }
      }
      return undefined;
    },
    keys: () => configState().keys,
  };

  // Whether some active context wants the panel open the moment it was
  // entered (key-context.ts's `showOnEntry`) — reactive both to a context
  // registering/retiring and to its own `active()` signal, since `contexts()`
  // reads the contribution table's signal and this calls `active()` on each.
  const showOnEntryActive = createMemo(() =>
    contexts().some((context) => context.showOnEntry === true && context.active()),
  );
  const rearmHintsOnKeyActive = () =>
    contexts().some((context) => context.rearmHintsOnKey === true && context.active());

  /** Arm or clear the panel's delay timer for one trigger going true/false.
   *  Shared by the two independent reasons the panel opens — a half-typed
   *  sequence and a `showOnEntry` context — so either one can win the single
   *  "hint-delay" fiber slot without the other's state going stale. */
  function armHintVisibility(triggered: boolean, stillTriggered: () => boolean) {
    runFiber("hint-delay", Effect.void);
    const timeoutMs = Duration.toMillis(bindings.chords.timeoutlen());
    const visibility = hintVisibility(
      triggered,
      options()["appearance.whichKeyHints"],
      options()["appearance.whichKeyDelay"],
      timeoutMs,
    );
    if (!visibility.visible && visibility.delayMs === 0) {
      setHintsVisible(false);
      return;
    }
    const show = () => {
      setHintsVisible(true);
      // Full timeoutlen from when the panel appears — otherwise a long
      // whichKeyDelay races the chord wait and the panel only flashes.
      bindings.chords.rearmTimeout();
    };
    if (visibility.visible) {
      show();
      return;
    }
    setHintsVisible(false);
    scheduleHintVisibility(runFiber, visibility.delayMs, stillTriggered, show);
  }

  function updateHintVisibility(sequence: readonly { display: string }[]) {
    setPendingParts(sequence);
    armHintVisibility(sequence.length > 0, () => pendingParts().length > 0 || showOnEntryActive());
  }

  // which-key: chord trie only. showcmd: one pending table (grammar/chord/count).
  // Cite: ts-5583b8; which-key must not route through the pending table.
  const disposeChordPending = bindings.chords.subscribe((strokes) => {
    updateHintVisibility(strokes.map((display) => ({ display })));
  });
  const disposeShowcmdPending = bindings.pending.subscribe(() => {
    setShowcmdEpoch((n) => n + 1);
  });
  const disposeHintRearm = bindings.keymap.intercept("key:after", (input) => {
    if (!input.handled || !rearmHintsOnKeyActive()) return;
    armHintVisibility(true, () => pendingParts().length > 0 || showOnEntryActive());
  });

  // `on` with `defer: true` only fires on an actual flip of showOnEntryActive
  // — false->true (arm, exactly like a keystroke arriving) or true->false
  // (drop the panel, unless a sequence is independently in progress). Never
  // on mount, so a context already active when the app starts doesn't pop
  // the panel it never "entered".
  createEffect(
    on(
      showOnEntryActive,
      (active) => {
        if (active) {
          armHintVisibility(true, () => pendingParts().length > 0 || showOnEntryActive());
        } else if (pendingParts().length === 0) {
          setHintsVisible(false);
        }
      },
      { defer: true },
    ),
  );

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
    applyOptions(optionsRuntime, options());
    setTheme(options()["appearance.theme"]);
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

  const pending = createMemo(() => {
    showcmdEpoch();
    const entries = bindings.pending.current();
    const strokesOf = (role: "grammar" | "chord" | "count") =>
      entries.find((entry) => entry.role === role)?.strokes ?? [];
    const grammar = strokesOf("grammar");
    const chordStrokes = strokesOf("chord");
    const count = strokesOf("count");
    if (chordStrokes.length === 0 && grammar.length === 0) return [];
    const chordSeq =
      chordStrokes.length > 0
        ? formatSequence(
            chordStrokes.map((display) => ({ display })),
            bindings.leaders(),
          )
        : "";
    const grammarSeq = grammar.join("");
    const digits = count[0] ?? "";
    const body = [grammarSeq, chordSeq].filter((part) => part.length > 0).join(" ");
    return [digits === "" ? body : `${body} ${digits}`];
  });
  const hints = createMemo(() =>
    // which-key is the chord trie only — operator grammar has no continuations list.
    pendingParts().length === 0
      ? []
      : nextKeys(bindings, bindings.commands(), contexts(), pendingParts()),
  );

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
    if (!entry || !mayDispatchPaletteEntry(entry)) return;
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
  const windowsPanel = (): DockOccupant => ({
    id: "amux.windows",
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
          const display = pane
            ? processDisplay.display({
                session: pane.id,
                state: pane.state,
                exitCode: pane.exitCode,
                detached: pane.detached,
                title: pane.title,
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
            window_name: display?.title ?? window?.title,
            window_number: window?.number,
            pane_index: pane ? window?.sessions.indexOf(pane) : undefined,
            pane_title: display?.title ?? pane?.title,
            pane_current_command: pane?.foregroundCommand,
            agent_state: display?.label,
            agent_state_label: display?.label,
            agent_state_glyph: display
              ? display.frames
                ? display.frames[app.frame() % display.frames.length]
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
  });

  // ↑↓ picks, enter pastes the selection into the focused pane, d deletes
  // it, escape closes. With no buffers there is nothing to pick, so only
  // escape does anything.
  function buffersOverlayKeys(event: KeyEvent): boolean {
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
  }

  const buffersPanel = (): OverlayOccupant => ({
    id: "amux.buffers",
    title: "buffers",
    visible: () => chooseView() !== null,
    component: (props) => (
      <Show when={chooseView()} keyed>
        {(view: BufferChooseView) => (
          <BufferChoose view={view} width={props.width} height={props.height} />
        )}
      </Show>
    ),
  });

  // s writes the file, f re-captures the other span, escape backs out
  // without saving. Everything else stays with the popup.
  function captureOverlayKeys(event: KeyEvent): boolean {
    const view = captureView();
    if (!view) return true;
    if (event.name === "s") view.onSave();
    else if (event.name === "f") view.onToggleSpan();
    else if (event.name === "escape") view.onClose();
    return true;
  }

  const capturePanel = (): OverlayOccupant => ({
    id: "amux.capture",
    title: "capture",
    visible: () => captureView() !== null,
    component: (props) => (
      <Show when={captureView()} keyed>
        {(view: CaptureView) => <Capture view={view} width={props.width} height={props.height} />}
      </Show>
    ),
  });

  function disconnectedOverlayKeys(event: KeyEvent): boolean {
    if (event.name === "escape" || event.name === "q") shutdown();
    return true;
  }

  const disconnectedPanel = (): OverlayOccupant => ({
    id: "amux.disconnected",
    title: "disconnected",
    visible: () => daemonDisconnected(),
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
        <text style={{ fg: theme.red, height: 1 }}>
          {disconnectReason() ? "Disconnected: " + disconnectReason() : "The daemon has stopped."}
        </text>
        <text style={{ height: 1 }}>
          {disconnectReason()
            ? "The daemon may still be running; reattach to resume."
            : "Session is gone; every command"}
        </text>
        <text style={{ fg: theme.overlay1, height: 1, marginTop: 1 }}>
          ^a q / q / escape — exit
        </text>
      </box>
    ),
  });

  // Slot placement lives here, beside the occupant, as the register call's
  //  discriminant — never embedded in the occupant itself.
  // Settings and command-palette chrome register from file-backed PluginEntries
  // (`plugins/settings.tsx`, `plugins/commands.tsx`).
  const panelGroups = {
    "amux.windows": (): readonly SlotsRegisterValue[] => [
      { slot: "top.center", occupant: windowsPanel() },
    ],
    "amux.sessions": (): readonly SlotsRegisterValue[] => [
      { slot: "overlay", occupant: buffersPanel(), priority: 20 },
      { slot: "overlay", occupant: capturePanel(), priority: 30 },
      { slot: "overlay", occupant: disconnectedPanel(), priority: 50 },
    ],
  } as const;

  // Each overlay's context, beside its occupant for the same reason: the
  // slot's `priority` is drawing/stacking order (topOverlay, ui/slots.ts) and
  // this is key-resolution order (activeHandler, key-context.ts) — the two
  // happen to agree here (both trace back to "the panel drawn on top owns the
  // keys"), so each context reuses its occupant's number, shifted into the
  // OVERLAY band. `handle` is the panel's old `OverlayOccupant.keys`: none of
  // these are expressible as discrete keymap bindings, since each reads
  // dynamic UI state (a list selection, an edit focus) no static key sequence
  // can capture — see ts-480690's log for why that stays a catch-all instead
  // of forcing them into named commands. `rebindable: false` because there is
  // nothing here a keybind editor could show or remap.
  const contextGroups = {
    "amux.sessions": (): readonly ContextSpec[] => [
      {
        id: "amux.buffers",
        active: () => chooseView() !== null,
        priority: CONTEXT_PRIORITY.OVERLAY + 20,
        rebindable: false,
        handle: buffersOverlayKeys,
      },
      {
        id: "amux.capture",
        active: () => captureView() !== null,
        priority: CONTEXT_PRIORITY.OVERLAY + 30,
        rebindable: false,
        handle: captureOverlayKeys,
      },
      {
        id: "amux.disconnected",
        active: () => daemonDisconnected(),
        priority: CONTEXT_PRIORITY.OVERLAY + 50,
        rebindable: false,
        handle: disconnectedOverlayKeys,
      },
    ],
    // Copy mode: the predicate is app.tsx:1941's old onUnhandled guard,
    // moved unchanged (ts-72f921's log: pane-pinning is state living in
    // copy.ts, expressed as a predicate rather than special-cased — the
    // mode outlives focus moving away because this simply goes false, not
    // because anything here holds onto it). The selection layer sits one
    // band above copy mode itself and claims only Escape, returning false
    // for everything else so `resolveUnhandled` falls through to copy
    // mode's own handler underneath it (ts-72f921's escape-layering: "a
    // selection exists" is a second context, not a switch inside one).
    "amux.copy-mode": (): readonly ContextSpec[] => [
      {
        id: "copy-mode",
        active: () => copyMode.active && copyMode.pane === spaces.activeWindow?.focused,
        priority: CONTEXT_PRIORITY.APP_MODE,
        rebindable: false,
        handle: (event) => copyMode.onKey(event),
        // v/y/n are only discoverable through this panel — copy.ts's onKey
        // decides what they mean from its own live state, so there is no
        // CommandSpec for `nextKeys` to read them back from (key-context.ts's
        // `hints`).
        showOnEntry: true,
        hints: [
          { keys: ["v", "space"], desc: "start selection" },
          { keys: ["y", "enter"], desc: "yank selection" },
          { keys: ["/"], desc: "search forward" },
          { keys: ["?"], desc: "search backward" },
          { keys: ["n"], desc: "repeat search" },
          { keys: ["N"], desc: "repeat search backward" },
          { keys: ["q", "esc"], desc: "exit" },
        ],
      },
      {
        id: "copy-mode.selection",
        active: () =>
          copyMode.active &&
          copyMode.hasSelection &&
          copyMode.pane === spaces.activeWindow?.focused,
        priority: CONTEXT_PRIORITY.APP_MODE + 1,
        rebindable: false,
        handle: (event) => {
          if (event.name !== "escape") return false;
          copyMode.clearSelection();
          return true;
        },
      },
    ],
  } as const;

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
    <Dynamic
      component={slots.Slot as ValidComponent}
      name="root"
      mode="replace"
      slots={slots}
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
      Effect.catch(() => Effect.logWarning("workspace projection did not finish during shutdown")),
    );
    // While the pane is still alive: the mode's exit clears the selection
    // through the pane's terminal, and a freed terminal cannot be caught.
    if (copyMode.active) copyMode.exit();
    spaces.refreshChrome();
    disposeChordPending();
    disposeShowcmdPending();
    disposeHintRearm();
    rawBindings.dispose();
    renderer.removeListener("resize", onResize);
  });

  /** Core options plus every plugin-registered one, resolved by the same rule —
   *  what a plugin reads through the injected panel service. */
  const allOptions = () => {
    const merged = { ...options() } as Options & Record<string, OptionValue>;
    for (const entry of optionsProvider.value.all())
      merged[entry.name] = optionValue(entry.name, entry.value);
    return merged as Options & Record<string, OptionValue>;
  };

  const overlayService = makeOverlay(overlay, setOverlay);

  const settingsChrome: SettingsChrome = {
    section: settingsSection,
    setSection: setSettingsSection,
    selected: settingsSelected,
    setSelected: setSettingsSelected,
    focus: settingsFocus,
    setFocus: setSettingsFocus,
    editText,
    setEditText,
    editOriginal,
    setEditOriginal,
    dirty: settingsDirty,
    error: settingsError,
    capturing,
    setCapturing,
    conflicts,
    prefix: () => configState().keys.prefix,
    leader: () => configState().keys.leader,
    groups,
    allOptions,
    pluginSections: pluginSettings,
    registeredOptions: () => optionsProvider.value.all(),
    registeredBindings,
    keybindPicker,
    setKeybindPicker,
    setKeybindList: (box) => {
      keybindList = box;
    },
    keybindList: () => keybindList,
    changeOption,
    adjustOption,
    saveOptions,
    saveSettings: () => {
      void saveSettings();
    },
    specFor,
    selectedOption,
    optionValue,
    openKeybindPicker,
    capturePrefix,
    captureLeader,
    resetBinding,
    captureBinding,
    dispatchBinding: (name) => {
      bindings.dispatch(name);
    },
    hasBinding: (name) => registeredBindings().some((binding) => binding.name === name),
    onEditInput: (value) => {
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
    },
    onEditSubmit: () => {
      setEditOriginal(null);
      setEditText(undefined);
      setSettingsFocus("items");
      saveOptions();
    },
    onKeybindPickerInput: (query) =>
      setKeybindPicker((current) =>
        current
          ? {
              ...current,
              query,
              selected: 0,
              entries: sortKeybindEntries(
                filterPaletteEntries(allPaletteEntries(), query, { includeHidden: true }),
              ),
            }
          : current,
      ),
  };

  const commandsChrome: CommandsChrome = {
    query: paletteQuery,
    setQuery: setPaletteQuery,
    selected: paletteSelected,
    setSelected: setPaletteSelected,
    entries: filteredPalette,
    submit: submitPalette,
    prompt: promptRequest,
    promptError,
    setPromptError,
    inspectLines,
    clearInspect: () => setInspectLines(null),
    pending: () => pending().join(" "),
    hintsVisible,
    hints,
    coreBindings: () => COMMANDS,
  };

  const panel = createPanelContext({
    snapshot,
    tick: app.tick,
    run: (value, input) =>
      isCoreCommand(value)
        ? runCommand(value, input).pipe(Effect.as(session.workspace()))
        : runRegisteredCommand(value, input).pipe(Effect.as(session.workspace())),
    options: allOptions,
    setOption: changeOption,
    saveOptions,
    display,
    reportError: showCommandError,
    unseenErrorCount,
    selectedAgentId,
    setSelectedAgentId,
  });
  const registries = [
    registry("slots", SlotsTag, externalProviders.slots, externalDefaults.slots),
    registry(
      "session-views",
      SessionViewsTag,
      externalProviders.sessionViews,
      externalDefaults.sessionViews,
    ),
    registry(
      "process-display",
      ProcessDisplayTag,
      externalProviders.processDisplay,
      externalDefaults.processDisplay,
    ),
    registry(
      "layout-kinds",
      LayoutKindsTag,
      externalProviders.layoutKinds,
      externalDefaults.layoutKinds,
    ),
    registry("bindings", BindingsTag, bindingsProvider, bindingsService),
    registry("contexts", ContextsTag, contextsProvider, contextsService),
    registry("settings", SettingsTag, settingsProvider, settingsService),
    registry("options", OptionsTag, optionsProvider, optionsService),
    registry(
      "spawn-providers",
      SpawnProvidersTag,
      externalProviders.spawnProviders,
      externalDefaults.spawnProviders,
    ),
    registry("commands", CommandsTag, commandsProvider, commandsService),
  ];
  const registryEntries = [
    ...registries.map((entry) => entry.plugin),
    // Apart from the rows above because it is not a registry: those publish a
    // default a plugin may replace, and are re-read through a provider ref when
    // one does. These two are the attached client itself. A host running
    // without a client — the CLI collecting plugin subcommands — omits this
    // entry, and every plugin that needs a UI is then left inactive rather than
    // handed a panel that draws nowhere.
    definePlugin({
      id: "amux.registry.client",
      provide: [
        PanelTag,
        SessionStreamTag,
        RemoteEventsTag,
        OverlayTag,
        SettingsChromeTag,
        CommandsChromeTag,
      ],
      effect: (ctx) =>
        Effect.sync(() => {
          ctx.provide(PanelTag, panel);
          ctx.provide(SessionStreamTag, {
            frames: (id) => session.attach.stream(id),
            sync: (id) => session.attach.sync(id),
          });
          ctx.provide(RemoteEventsTag, { events: session.events });
          ctx.provide(OverlayTag, overlayService);
          ctx.provide(SettingsChromeTag, settingsChrome);
          ctx.provide(CommandsChromeTag, commandsChrome);
        }),
    }),
  ];
  const sessionFacts = makeSessionFacts(() => spaces.allSessions);

  const updateRegistry = (host: PluginHost, key: string): void => {
    for (const entry of registries) if (entry.key === key) entry.refresh(host);
  };

  const coreEntries = [
    definePlugin({
      id: "amux.session-facts",
      provide: [SessionFactsTag],
      effect: (ctx) => Effect.sync(() => void ctx.provide(SessionFactsTag, sessionFacts)),
    }),
    definePlugin({
      id: "amux.windows",
      inject: [SlotsTag],
      effect: () =>
        SlotsTag.pipe(
          Effect.flatMap((slots) =>
            Effect.forEach(panelGroups["amux.windows"](), (entry) => slots.register(entry)),
          ),
        ),
    }),
    definePlugin({
      id: "amux.copy-mode",
      inject: [ContextsTag],
      effect: () =>
        ContextsTag.pipe(
          Effect.flatMap((contexts) =>
            Effect.forEach(contextGroups["amux.copy-mode"](), (context) =>
              contexts.register(context),
            ),
          ),
        ),
    }),
    definePlugin({
      id: "amux.sessions",
      inject: [SlotsTag, ContextsTag],
      effect: () =>
        Effect.gen(function* () {
          const slots = yield* SlotsTag;
          const contexts = yield* ContextsTag;
          yield* Effect.forEach(panelGroups["amux.sessions"](), (entry) => slots.register(entry));
          yield* Effect.forEach(contextGroups["amux.sessions"](), (context) =>
            contexts.register(context),
          );
        }),
    }),
  ] as const;
  const consumers = [
    defineConsumer({
      name: "core dispatch",
      inject: [BindingsTag, CommandsTag],
      effect: () =>
        Effect.gen(function* () {
          bindingsProvider.set(yield* BindingsTag);
          commandsProvider.set(yield* CommandsTag);
        }),
    }),
  ] as const;
  const pluginEntries: readonly PluginEntry[] = [
    {
      id: "amux.settings",
      source: new URL("./plugins/settings.tsx", import.meta.url),
      definition: settingsPlugin,
    },
    {
      id: "amux.commands",
      source: new URL("./plugins/commands.tsx", import.meta.url),
      definition: commandsPlugin,
    },
  ];

  return {
    View,
    panel,
    release,
    commands,
    registryEntries,
    consumers,
    updateRegistry,
    coreEntries: [...coreEntries, ...pluginEntries.map((entry) => entry.definition)],
    pluginEntries,
  };
}
