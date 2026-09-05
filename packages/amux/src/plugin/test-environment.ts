import { Effect, Scope, Stream } from "effect";
import type { CliRenderer } from "@opentui/core";
import type { PluginEnvironment } from "./host.ts";
import { createSessionViews, type SessionViews } from "./session-views.tsx";
import {
  createProcessDisplay,
  type ProcessDisplay,
  type ProcessDisplayProvider,
} from "./process-display.ts";
import { createPluginContributions, type PluginInstance } from "./contributions.ts";
import { createSlots, type Slots } from "../ui/slots.ts";
import { testPanelContext } from "../ui/test-panel.ts";
import type { PanelContext } from "../ui/panel.ts";
import type { AttachFrame } from "../effect/AttachProtocol.ts";
import {
  definePlugin,
  type PluginDefinition,
  type PluginSettingsSection,
  type SpawnProvider,
} from "./types.ts";
import type { OptionSpec } from "../options.ts";
import { createBindings, type CommandSpec } from "../bindings.ts";
import { makeCommands } from "../commands.ts";
import type { PaneView } from "../component-pane.tsx";
import {
  BindingsTag,
  CommandsTag,
  CurrentPlugin,
  OptionsTag,
  PanelTag,
  ProcessDisplayTag,
  SlotsTag,
  SessionViewsTag,
  SettingsTag,
  SessionStreamTag,
  SpawnProvidersTag,
  scopedRegistry,
  type CommandRegistration,
  type SlotsRegisterValue,
} from "./services.ts";

interface RawTestRegistries {
  readonly slots: Slots;
  readonly sessionViews: SessionViews;
  readonly processDisplay: ProcessDisplay;
  readonly bindings: (owner: PluginInstance, binding: CommandSpec) => () => void;
  readonly settings: (owner: PluginInstance, section: PluginSettingsSection) => () => void;
  readonly options: (owner: PluginInstance, name: string, spec: OptionSpec) => () => void;
  readonly spawnProviders: (
    owner: PluginInstance,
    id: string,
    provider: () => SpawnProvider,
  ) => () => void;
  readonly spawnProvider: (id: string) => SpawnProvider | undefined;
  readonly commands: (owner: PluginInstance, registration: CommandRegistration) => () => void;
}

export type TestPluginEnvironment = PluginEnvironment & {
  readonly registries: RawTestRegistries;
  readonly registryEntries: readonly PluginDefinition[];
};

type TestEnvironmentParts = Omit<Partial<PluginEnvironment>, "contributions"> & {
  readonly panel?: PanelContext;
  readonly frames?: (session: string) => Stream.Stream<AttachFrame, never>;
  readonly sync?: (session: string) => void;
  readonly slots?: Slots;
  readonly sessionViews?: SessionViews;
  readonly processDisplay?: ProcessDisplay;
  readonly registries?: Partial<RawTestRegistries>;
  readonly contributions?: PluginEnvironment["contributions"];
};

export function testPluginEnvironment(
  renderer: CliRenderer,
  parts: TestEnvironmentParts = {},
): TestPluginEnvironment {
  const contributions = parts.contributions ?? createPluginContributions();
  const slots = parts.slots ?? createSlots(renderer, contributions);
  const sessionViews = parts.sessionViews ?? createSessionViews(contributions);
  const processDisplay = parts.processDisplay ?? createProcessDisplay(contributions);
  const bindingTable = contributions.table<CommandSpec>();
  const settingsTable = contributions.table<PluginSettingsSection>();
  const optionsTable = contributions.table<OptionSpec>();
  const spawnProviders = contributions.table<() => SpawnProvider>();
  const commandTable = contributions.table<CommandRegistration>();
  const panel = parts.panel ?? testPanelContext();
  const sessionStream = {
    frames: parts.frames ?? (() => Stream.empty),
    sync: parts.sync ?? (() => {}),
  };
  const rawBindings = createBindings(renderer, [], { onUnhandled: () => false });
  const rawCommands = makeCommands({});
  const registries: RawTestRegistries = {
    slots,
    sessionViews,
    processDisplay,
    bindings: (owner, binding) => bindingTable.add(owner, binding.name, binding),
    settings: (owner, section) => settingsTable.add(owner, section.id, section),
    options: (owner, name, spec) => optionsTable.add(owner, name, spec),
    spawnProviders: (owner, id, provider) => spawnProviders.add(owner, id, provider),
    spawnProvider: (id) => spawnProviders.get(id)?.(),
    commands: (owner, registration) => commandTable.add(owner, registration.verb, registration),
    ...parts.registries,
  };
  const services = {
    slots: {
      ...{
        Slot: slots.Slot,
        declared: slots.declared,
        thickness: slots.thickness,
        divider: slots.divider,
        topOverlay: slots.topOverlay,
      },
      register: (entry: SlotsRegisterValue) =>
        Effect.gen(function* () {
          const owner = yield* CurrentPlugin;
          const scope = yield* Scope.Scope;
          // The union discriminant narrows each branch onto the matching
          // `Slots.register` overload — a mismatched pair fails to compile.
          const dispose =
            entry.slot === "overlay"
              ? slots.register(owner, entry.slot, entry.occupant, entry.priority)
              : entry.slot === "float"
                ? slots.register(owner, entry.slot, entry.occupant, entry.priority)
                : slots.register(owner, entry.slot, entry.occupant, entry.priority);
          yield* Scope.addFinalizer(scope, Effect.sync(dispose));
        }),
    },
    sessionViews: scopedRegistry(
      { view: sessionViews.view, has: sessionViews.has },
      (owner, [type, view]: readonly [string, PaneView]) =>
        registries.sessionViews.register(owner, type, view),
    ),
    processDisplay: scopedRegistry(
      { display: processDisplay.display },
      (owner, provider: ProcessDisplayProvider) =>
        registries.processDisplay.register(owner, provider),
    ),
    bindings: scopedRegistry(rawBindings, registries.bindings),
    settings: scopedRegistry(
      { all: () => settingsTable.all().map((entry) => entry.value) },
      registries.settings,
    ),
    options: scopedRegistry(
      { get: optionsTable.get, all: optionsTable.all },
      (owner, [name, spec]: readonly [string, OptionSpec]) => registries.options(owner, name, spec),
    ),
    spawnProviders: scopedRegistry(
      { get: registries.spawnProvider },
      (owner, [id, provider]: readonly [string, () => SpawnProvider]) =>
        registries.spawnProviders(owner, id, provider),
    ),
    commands: scopedRegistry(
      {
        run: rawCommands.run,
        list: rawCommands.list,
        isWorkspaceCommand: rawCommands.isWorkspaceCommand,
        isRemoteCommand: rawCommands.isRemoteCommand,
      },
      registries.commands,
    ),
  };
  const provider = (
    id: string,
    tag: { readonly key: string },
    publish: (ctx: Parameters<PluginDefinition["activate"]>[0]) => void,
  ): PluginDefinition => ({
    id,
    provide: [tag],
    activate: (ctx) => Effect.sync(() => publish(ctx)),
  });
  const registryEntries = [
    provider("amux.registry.slots", SlotsTag, (ctx) => void ctx.provide(SlotsTag, services.slots)),
    provider(
      "amux.registry.session-views",
      SessionViewsTag,
      (ctx) => void ctx.provide(SessionViewsTag, services.sessionViews),
    ),
    provider(
      "amux.registry.process-display",
      ProcessDisplayTag,
      (ctx) => void ctx.provide(ProcessDisplayTag, services.processDisplay),
    ),
    provider(
      "amux.registry.bindings",
      BindingsTag,
      (ctx) => void ctx.provide(BindingsTag, services.bindings),
    ),
    provider(
      "amux.registry.settings",
      SettingsTag,
      (ctx) => void ctx.provide(SettingsTag, services.settings),
    ),
    provider(
      "amux.registry.options",
      OptionsTag,
      (ctx) => void ctx.provide(OptionsTag, services.options),
    ),
    provider(
      "amux.registry.spawn-providers",
      SpawnProvidersTag,
      (ctx) => void ctx.provide(SpawnProvidersTag, services.spawnProviders),
    ),
    provider(
      "amux.registry.commands",
      CommandsTag,
      (ctx) => void ctx.provide(CommandsTag, services.commands),
    ),
    definePlugin({
      id: "amux.registry.client",
      provide: [PanelTag, SessionStreamTag],
      effect: (ctx) =>
        Effect.sync(() => {
          ctx.provide(PanelTag, panel);
          ctx.provide(SessionStreamTag, sessionStream);
        }),
    }),
  ];
  const {
    slots: _slots,
    sessionViews: _sessionViews,
    processDisplay: _processDisplay,
    registries: _registries,
    panel: _panel,
    frames: _frames,
    sync: _sync,
    ...environment
  } = parts;
  return {
    ...environment,
    contributions,
    registries,
    registryEntries,
  };
}
