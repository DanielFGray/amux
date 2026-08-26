import { Context, Deferred, Effect, FiberId, Option, Scope, type Schema as S } from "effect";
import type { PluginInstance } from "./contributions.ts";
import type { Panel, Regions } from "../ui/regions.tsx";
import type { SessionViews } from "./session-views.tsx";
import type { PaneView } from "../component-pane.tsx";
import type { CommandSpec } from "../bindings.ts";
import type { PluginSettingsSection, SpawnProvider } from "./types.ts";
import type { OptionSpec } from "../options.ts";
import type { ProcessDisplay, ProcessDisplayProvider } from "./process-display.ts";
import type { CommandError, Meta } from "../commands.ts";

export class CurrentPlugin extends Context.Tag("amux/CurrentPlugin")<
  CurrentPlugin,
  PluginInstance
>() {}

export interface PluginRegistries {
  readonly regions: Regions;
  readonly sessionViews: SessionViews;
  readonly processDisplay: ProcessDisplay;
  readonly bindings: (owner: PluginInstance, binding: CommandSpec) => () => void;
  readonly settings: (owner: PluginInstance, section: PluginSettingsSection) => () => void;
  /** Claim a dotted option name in the settings table: typed, validated,
   *  bounds-checked, and rendered by the generic settings row the way a core
   *  option is. */
  readonly options: (owner: PluginInstance, name: string, spec: OptionSpec) => () => void;
  readonly spawnProviders: (
    owner: PluginInstance,
    id: string,
    provider: () => SpawnProvider,
  ) => () => void;
  readonly spawnProvider: (id: string) => SpawnProvider | undefined;
  /** Claim `plugin.<id>.<verb>` in the command registry — the same table core
   *  commands live in, so a plugin verb is bindable, paletted, and (when its
   *  `target` is not `"view"`) reachable from the CLI, on equal footing. */
  readonly commands: (owner: PluginInstance, registration: CommandRegistration) => () => void;
}

/** A plugin verb, erased to `any` at this boundary the same way the runtime
 *  command table already is (see `PluginCommandEntry` in commands.ts) — the
 *  type-safe surface is `registerCommand`, below, which a plugin actually calls. */
export interface CommandRegistration {
  readonly verb: string;
  readonly fields: S.Struct.Fields;
  readonly meta: Meta;
  readonly handler: (args: any) => Effect.Effect<unknown, CommandError>;
}

export interface RegistryService<A> {
  readonly register: (value: A) => Effect.Effect<void, never, CurrentPlugin | Scope.Scope>;
}

export class RegionsTag extends Context.Tag("amux/Regions")<RegionsTag, RegistryService<Panel>>() {}
export class SessionViewsTag extends Context.Tag("amux/SessionViews")<
  SessionViewsTag,
  RegistryService<readonly [string, PaneView]>
>() {}
export class ProcessDisplayTag extends Context.Tag("amux/ProcessDisplay")<
  ProcessDisplayTag,
  RegistryService<ProcessDisplayProvider>
>() {}
export class BindingsTag extends Context.Tag("amux/Bindings")<
  BindingsTag,
  RegistryService<CommandSpec>
>() {}
export class SettingsTag extends Context.Tag("amux/Settings")<
  SettingsTag,
  RegistryService<PluginSettingsSection>
>() {}
export class OptionsTag extends Context.Tag("amux/Options")<
  OptionsTag,
  RegistryService<readonly [string, OptionSpec]>
>() {}
export class SpawnProvidersTag extends Context.Tag("amux/SpawnProviders")<
  SpawnProvidersTag,
  RegistryService<readonly [string, () => SpawnProvider]>
>() {}
export class CommandsTag extends Context.Tag("amux/Commands")<
  CommandsTag,
  RegistryService<CommandRegistration>
>() {}

/**
 * The type-safe surface over `CommandsTag`: `CommandRegistration.fields` is
 * erased to the base `S.Struct.Fields` the registry stores, so a plugin
 * would otherwise lose argument inference the moment it registered. This
 * recovers it the same way `commands.ts`'s own `registerCommand` does.
 */
export const registerCommand = <Fields extends S.Struct.Fields>(
  verb: string,
  fields: Fields,
  meta: Meta,
  handler: (args: S.Struct.Type<Fields>) => Effect.Effect<unknown, CommandError>,
): Effect.Effect<void, never, CommandsTag | CurrentPlugin | Scope.Scope> =>
  CommandsTag.pipe(
    Effect.flatMap((commands) => commands.register({ verb, fields, meta, handler })),
  );

export interface PluginService {
  readonly key: string;
  readonly _op: "Tag";
}

export interface PluginServices {
  readonly provide: <Id, S>(owner: PluginInstance, tag: Context.Tag<Id, S>, service: S) => void;
  readonly withdraw: (owner: PluginInstance, tag: PluginService) => void;
  readonly withdrawAll: (owner: PluginInstance) => void;
  readonly get: <Id, S>(tag: Context.Tag<Id, S>) => Option.Option<S>;
  /** Make an instance's staged services available to injectors. */
  readonly commit: (owner: PluginInstance) => void;
  readonly retire: (owner: PluginInstance) => void;
  readonly declare: (owner: PluginInstance, tags: readonly PluginService[]) => void;
  readonly forget: (owner: PluginInstance) => void;
  readonly awaitAll: (tags: readonly PluginService[]) => Effect.Effect<Context.Context<never>>;
  readonly waitingOn: (owner: PluginInstance) => readonly string[];
  readonly dependentsOf: (owner: PluginInstance) => readonly string[];
}

/**
 * Service instances stage beside the committed provider, just like UI
 * contributions. A replacement becomes readable only when its host generation
 * commits; until then injectors keep the service they already acquired.
 */
export function createPluginServices(): PluginServices {
  const slots = new Map<string, Slot>();
  const injects = new Map<
    string,
    { readonly owner: PluginInstance; readonly tags: readonly PluginService[] }
  >();
  const committed = new Map<string, number>();

  function slotFor(key: string): Slot {
    let slot = slots.get(key);
    if (!slot) {
      slot = { deferred: Deferred.unsafeMake(FiberId.none), provider: undefined, providers: [] };
      slots.set(key, slot);
    }
    return slot;
  }

  function visible(slot: Slot): Provider | undefined {
    return slot.providers.find(
      (provider) => committed.get(provider.owner.id) === provider.owner.generation,
    );
  }

  function update(slot: Slot): void {
    const provider = visible(slot);
    if (slot.provider === provider) return;
    const previous = slot.provider;
    slot.provider = provider;
    if (!previous && provider) {
      Deferred.unsafeDone(slot.deferred, Effect.succeed(provider.context));
      return;
    }
    slot.deferred = Deferred.unsafeMake(FiberId.none);
    if (provider) Deferred.unsafeDone(slot.deferred, Effect.succeed(provider.context));
  }

  return {
    provide(owner, tag, service) {
      const slot = slotFor(tag.key);
      const conflict = slot.providers.find((provider) => provider.owner.id !== owner.id);
      if (conflict)
        throw new Error(`service '${tag.key}' is already provided by '${conflict.owner.id}'`);
      if (slot.providers.some((provider) => sameInstance(provider.owner, owner)))
        throw new Error(`plugin '${owner.id}' provided '${tag.key}' twice`);
      slot.providers.push({ owner, context: Context.make(tag, service) });
      update(slot);
    },

    withdraw(owner, tag) {
      const slot = slots.get(tag.key);
      if (!slot) return;
      slot.providers = slot.providers.filter((provider) => !sameInstance(provider.owner, owner));
      update(slot);
    },

    withdrawAll(owner) {
      for (const slot of slots.values()) {
        slot.providers = slot.providers.filter((provider) => !sameInstance(provider.owner, owner));
        update(slot);
      }
    },

    get: <Id, S>(tag: Context.Tag<Id, S>) =>
      Option.fromNullable(slots.get(tag.key)?.provider).pipe(
        Option.flatMap((provider) => Context.getOption(provider.context, tag)),
      ),

    commit(owner) {
      committed.set(owner.id, owner.generation);
      for (const slot of slots.values()) update(slot);
    },

    retire(owner) {
      if (committed.get(owner.id) !== owner.generation) return;
      committed.delete(owner.id);
      for (const slot of slots.values()) update(slot);
    },

    declare(owner, tags) {
      injects.set(instanceKey(owner), { owner, tags });
    },

    forget(owner) {
      injects.delete(instanceKey(owner));
    },

    awaitAll: (tags: readonly PluginService[]) =>
      Effect.gen(function* () {
        let context = Context.empty();
        for (const tag of tags) {
          context = Context.mergeAll(context, yield* Deferred.await(slotFor(tag.key).deferred));
        }
        return context;
      }),

    waitingOn: (owner) =>
      (injects.get(instanceKey(owner))?.tags ?? [])
        .filter((tag) => !slots.get(tag.key)?.provider)
        .map((tag) => tag.key),

    dependentsOf(owner) {
      const provided = new Set(
        [...slots]
          .filter(([, slot]) =>
            slot.providers.some((provider) => sameInstance(provider.owner, owner)),
          )
          .map(([key]) => key),
      );
      if (provided.size === 0) return [];
      return [...injects.values()]
        .filter(({ tags }) => tags.some((tag) => provided.has(tag.key)))
        .map(({ owner }) => owner.id);
    },
  };
}

interface Slot {
  deferred: Deferred.Deferred<Context.Context<never>>;
  provider: Provider | undefined;
  providers: Provider[];
}

interface Provider {
  readonly owner: PluginInstance;
  readonly context: Context.Context<never>;
}

const instanceKey = (owner: PluginInstance) => `${owner.id}#${owner.generation}`;
const sameInstance = (a: PluginInstance, b: PluginInstance) =>
  a.id === b.id && a.generation === b.generation;
