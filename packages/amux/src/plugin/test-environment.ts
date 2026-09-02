import { Effect, Stream } from "effect";
import type { CliRenderer } from "@opentui/core";
import type { PluginEnvironment } from "./host.ts";
import { createSessionViews, type SessionViews } from "./session-views.tsx";
import {
  createProcessDisplay,
  type ProcessDisplay,
  type ProcessDisplayProvider,
} from "./process-display.ts";
import { createPluginContributions, type PluginInstance } from "./contributions.ts";
import { createRegions, type Regions } from "../ui/regions.tsx";
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
  OptionsTag,
  PanelTag,
  ProcessDisplayTag,
  RegionsTag,
  SessionViewsTag,
  SettingsTag,
  SessionStreamTag,
  SpawnProvidersTag,
  scopedRegistry,
  type CommandRegistration,
} from "./services.ts";

interface RawTestRegistries {
  readonly regions: Regions;
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
  readonly regions?: Regions;
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
  const regions = parts.regions ?? createRegions(renderer, contributions);
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
    regions,
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
    regions: scopedRegistry(
      {
        Slot: regions.Slot,
        declared: regions.declared,
        thickness: regions.thickness,
        divider: regions.divider,
        topOverlay: regions.topOverlay,
      },
      registries.regions.register,
    ),
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
    apiVersion: "1",
    provide: [tag],
    activate: (ctx) => Effect.sync(() => publish(ctx)),
  });
  const registryEntries = [
    provider(
      "amux.registry.regions",
      RegionsTag,
      (ctx) => void ctx.provide(RegionsTag, services.regions),
    ),
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
      apiVersion: "1",
      provide: [PanelTag, SessionStreamTag],
      effect: (ctx) =>
        Effect.sync(() => {
          ctx.provide(PanelTag, panel);
          ctx.provide(SessionStreamTag, sessionStream);
        }),
    }),
  ];
  const {
    regions: _regions,
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
