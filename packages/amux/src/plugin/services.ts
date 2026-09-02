import { Context, Deferred, Effect, Option, Scope, type Schema as S, type Stream } from "effect";
import type { Contribution, PluginInstance } from "./contributions.ts";
import type { Panel, Regions } from "../ui/regions.tsx";
import type { SessionViews } from "./session-views.tsx";
import type { PaneView } from "../component-pane.tsx";
import type { Bindings, CommandSpec } from "../bindings.ts";
import type { PluginSettingsSection, SpawnProvider } from "./types.ts";
import type { OptionSpec } from "../options.ts";
import type { ProcessDisplay, ProcessDisplayProvider } from "./process-display.ts";
import type { CommandError, Commands, Meta } from "../commands.ts";
import type { SessionFactsService } from "../session-facts.ts";
import type { PanelContext } from "../ui/panel.ts";
import type { AttachFrame } from "../effect/AttachProtocol.ts";

export class CurrentPlugin extends Context.Service<CurrentPlugin, PluginInstance>()(
  "amux/CurrentPlugin",
) {}

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

export type RegionsService = Omit<Regions, "register"> & RegistryService<Panel>;
export type SessionViewsService = Omit<SessionViews, "register"> &
  RegistryService<readonly [string, PaneView]>;
export type ProcessDisplayService = Omit<ProcessDisplay, "register"> &
  RegistryService<ProcessDisplayProvider>;
export type BindingsService = Bindings & RegistryService<CommandSpec>;
export interface SettingsService extends RegistryService<PluginSettingsSection> {
  readonly all: () => readonly PluginSettingsSection[];
}
export interface OptionsService extends RegistryService<readonly [string, OptionSpec]> {
  readonly get: (name: string) => OptionSpec | undefined;
  readonly all: () => readonly Contribution<OptionSpec>[];
}
export interface SpawnProvidersService extends RegistryService<
  readonly [string, () => SpawnProvider]
> {
  readonly get: (id: string) => SpawnProvider | undefined;
}
export type CommandsService = Omit<Commands, "registerCommand"> &
  RegistryService<CommandRegistration>;

/**
 * A subcommand a plugin contributes to the bare `amux` binary — a setup verb
 * like installing a hook file, not a second command system. `handler` gets
 * the remaining argv and reports its own outcome as an exit code; there is no
 * daemon or attached client backing it, so it cannot assume one.
 */
export interface CliCommandRegistration {
  readonly name: string;
  readonly description: string;
  readonly handler: (argv: readonly string[]) => Effect.Effect<number>;
}
export interface CliCommandsService extends RegistryService<CliCommandRegistration> {
  readonly all: () => readonly Contribution<CliCommandRegistration>[];
}

export class RegionsTag extends Context.Service<RegionsTag, RegionsService>()("amux/Regions") {}
export class SessionViewsTag extends Context.Service<SessionViewsTag, SessionViewsService>()(
  "amux/SessionViews",
) {}
export class ProcessDisplayTag extends Context.Service<ProcessDisplayTag, ProcessDisplayService>()(
  "amux/ProcessDisplay",
) {}
export class BindingsTag extends Context.Service<BindingsTag, BindingsService>()("amux/Bindings") {}
export class SettingsTag extends Context.Service<SettingsTag, SettingsService>()("amux/Settings") {}
export class OptionsTag extends Context.Service<OptionsTag, OptionsService>()("amux/Options") {}
export class SpawnProvidersTag extends Context.Service<SpawnProvidersTag, SpawnProvidersService>()(
  "amux/SpawnProviders",
) {}
export class CommandsTag extends Context.Service<CommandsTag, CommandsService>()("amux/Commands") {}
export class CliCommandsTag extends Context.Service<CliCommandsTag, CliCommandsService>()(
  "amux/CliCommands",
) {}
export class SessionFactsTag extends Context.Service<SessionFactsTag, SessionFactsService>()(
  "amux/SessionFacts",
) {}
export class PanelTag extends Context.Service<PanelTag, PanelContext>()("amux/Panel") {}
/** One service rather than two keys: reading a session's frames and asking for
 *  a replay are the same capability seen from both ends, and a plugin holding
 *  one without the other could only ever watch a stream it cannot rewind. */
export interface SessionStreamService {
  readonly frames: (session: string) => Stream.Stream<AttachFrame, never>;
  readonly sync: (session: string) => void;
}
export class SessionStreamTag extends Context.Service<SessionStreamTag, SessionStreamService>()(
  "amux/SessionStream",
) {}

export const scopedRegistry = <A extends object, Value>(
  capability: A,
  register: (owner: PluginInstance, value: Value) => () => void,
): A & RegistryService<Value> => ({
  ...capability,
  register: (value) =>
    Effect.gen(function* () {
      const owner = yield* CurrentPlugin;
      const scope = yield* Scope.Scope;
      const dispose = register(owner, value);
      yield* Scope.addFinalizer(scope, Effect.sync(dispose));
    }),
});

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
}

export interface ServiceInterception<Service, Metadata> {
  readonly empty: Metadata;
  readonly combine: (left: Metadata, right: Metadata) => Metadata;
  readonly access: (service: Service, metadata: () => Metadata) => Service;
}

export type InterceptablePluginService<Id, Service, Metadata> = Context.Service<Id, Service> & {
  readonly interception: ServiceInterception<Service, Metadata>;
};

export interface InterceptedDependency<
  Service extends PluginService = PluginService,
  Metadata = unknown,
> {
  readonly service: Service;
  readonly metadata: Metadata;
}

export type PluginDependency = PluginService | InterceptedDependency;

export const intercept = <Id, Service, Metadata>(
  service: InterceptablePluginService<Id, Service, Metadata>,
  metadata: NoInfer<Metadata>,
): InterceptedDependency<typeof service, Metadata> => ({ service, metadata });

export const dependencyService = (dependency: PluginDependency): PluginService =>
  "service" in dependency ? dependency.service : dependency;

const serviceInterception = (
  service: PluginService,
): ServiceInterception<unknown, unknown> | undefined =>
  "interception" in service
    ? (service as PluginService & { readonly interception: ServiceInterception<unknown, unknown> })
        .interception
    : undefined;

export interface PluginServices {
  readonly provide: <Id, S>(owner: PluginInstance, tag: Context.Service<Id, S>, service: S) => void;
  readonly withdraw: (owner: PluginInstance, tag: PluginService) => void;
  readonly withdrawAll: (owner: PluginInstance) => void;
  readonly get: <Id, S>(tag: Context.Service<Id, S>) => Option.Option<S>;
  /** Make an instance's staged services available to injectors. */
  readonly commit: (owner: PluginInstance) => void;
  readonly retire: (owner: PluginInstance) => void;
  readonly declare: (owner: PluginInstance, dependencies: readonly PluginDependency[]) => void;
  readonly intercept: <Id, Service, Metadata>(
    owner: string,
    tag: InterceptablePluginService<Id, Service, Metadata>,
    metadata: Metadata,
  ) => void;
  readonly clearInterception: (owner: string, tag: PluginService) => void;
  readonly forget: (owner: PluginInstance) => void;
  readonly awaitAll: (
    owner: PluginInstance,
    dependencies: readonly PluginDependency[],
  ) => Effect.Effect<Context.Context<never>>;
  readonly waitingOn: (owner: PluginInstance) => readonly string[];
  readonly dependentsOf: (owner: PluginInstance) => readonly string[];
}

/**
 * Service instances stage beside the committed provider, just like UI
 * contributions. A replacement becomes readable only when its host generation
 * commits; until then injectors keep the service they already acquired.
 */
export function createPluginServices(onChange: (key: string) => void = () => {}): PluginServices {
  const slots = new Map<string, Slot>();
  const injects = new Map<
    string,
    {
      readonly owner: PluginInstance;
      readonly dependencies: readonly PluginDependency[];
      committed: ReadonlyMap<string, PluginInstance> | undefined;
    }
  >();
  const interceptions = new Map<string, unknown>();
  const committed = new Map<string, number>();

  function slotFor(key: string): Slot {
    let slot = slots.get(key);
    if (!slot) {
      slot = { key, deferred: Deferred.makeUnsafe(), provider: undefined, providers: [] };
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
    onChange(slot.key);
    if (!previous && provider) {
      Deferred.doneUnsafe(slot.deferred, Effect.succeed(provider));
      return;
    }
    slot.deferred = Deferred.makeUnsafe();
    if (provider) Deferred.doneUnsafe(slot.deferred, Effect.succeed(provider));
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

    get: <Id, S>(tag: Context.Service<Id, S>) =>
      Option.fromNullishOr(slots.get(tag.key)?.provider).pipe(
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

    declare(owner, dependencies) {
      injects.set(instanceKey(owner), { owner, dependencies, committed: undefined });
    },

    intercept(owner, tag, metadata) {
      interceptions.set(interceptionKey(owner, tag.key), metadata);
    },

    clearInterception(owner, tag) {
      interceptions.delete(interceptionKey(owner, tag.key));
    },

    forget(owner) {
      injects.delete(instanceKey(owner));
    },

    awaitAll: (owner, dependencies) =>
      Effect.gen(function* () {
        let context = Context.empty();
        let suspended = false;
        const view = new Map<string, PluginInstance>();
        for (const dependency of dependencies) {
          const tag = dependencyService(dependency);
          const { deferred } = slotFor(tag.key);
          suspended ||= !Deferred.isDoneUnsafe(deferred);
          const provider = yield* Deferred.await(deferred);
          const service = Context.getUnsafe(provider.context, tag as Context.Key<unknown, unknown>);
          const interception = serviceInterception(tag);
          const value = interception
            ? interception.access(service, () => {
                const declared = "service" in dependency ? dependency.metadata : interception.empty;
                const installed = interceptions.get(interceptionKey(owner.id, tag.key));
                return installed === undefined
                  ? declared
                  : interception.combine(declared, installed);
              })
            : service;
          context = Context.addUnsafe(context, tag.key, value);
          view.set(tag.key, provider.owner);
        }
        const declaration = injects.get(instanceKey(owner));
        if (declaration) declaration.committed = view;
        // A provider completes these deferreds from inside its own activation,
        // and the runtime resumes a waiter inline on the completer's stack.
        // Taking a turn after a real suspension is what keeps a dependent's
        // activation after its provider's rather than in the middle of it: the
        // provider's finalizers and its remaining services are registered first.
        if (suspended) yield* Effect.yieldNow;
        return context;
      }),

    waitingOn: (owner) =>
      (injects.get(instanceKey(owner))?.dependencies ?? [])
        .map(dependencyService)
        .filter((tag) => !slots.get(tag.key)?.provider)
        .map((tag) => tag.key),

    dependentsOf(owner) {
      return [...injects.values()]
        .filter(({ dependencies, committed: view }) => {
          if (!view || ![...view.values()].some((provider) => sameInstance(provider, owner)))
            return false;
          return dependencies.map(dependencyService).some((tag) => {
            const committedProvider = view.get(tag.key);
            const targetProvider = slots.get(tag.key)?.provider?.owner;
            return (
              !committedProvider ||
              !targetProvider ||
              !sameInstance(committedProvider, targetProvider)
            );
          });
        })
        .map(({ owner }) => owner.id);
    },
  };
}

interface Slot {
  readonly key: string;
  deferred: Deferred.Deferred<Provider>;
  provider: Provider | undefined;
  providers: Provider[];
}

interface Provider {
  readonly owner: PluginInstance;
  readonly context: Context.Context<never>;
}

const instanceKey = (owner: PluginInstance) => `${owner.id}#${owner.generation}`;
const interceptionKey = (owner: string, key: string) => `${owner}\0${key}`;
const sameInstance = (a: PluginInstance, b: PluginInstance) =>
  a.id === b.id && a.generation === b.generation;
