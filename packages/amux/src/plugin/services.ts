import { Context, Deferred, Effect, Option, Scope, type Schema as S, type Stream } from "effect";
import type { Contribution, PluginContributions, PluginInstance } from "./contributions.ts";
import type {
  DockOccupant,
  DockSlotName,
  FloatOccupant,
  OverlayOccupant,
  Slots,
} from "../ui/slots.ts";
import type { SessionViews } from "./session-views.tsx";
import type { PaneView } from "../component-pane.tsx";
import type { Bindings, CommandSpec } from "../bindings.ts";
import type { ContextPriorityConflict, ContextSpec } from "../key-context.ts";
import type { PluginSettingsSection, SpawnProvider } from "./types.ts";
import type { OptionSpec } from "../options.ts";
import type { ProcessDisplay, ProcessDisplayProvider } from "./process-display.ts";
import type { CommandError, Commands, Meta, RuntimeCommand } from "../commands.ts";
export { SessionFactsTag } from "../session-facts.ts";
import type { PanelContext } from "../ui/panel.ts";
import type { AttachFrame } from "../effect/AttachProtocol.ts";
import type { TilingAlgorithm } from "../tiling-algorithm.ts";
import { defaultTilingAlgorithm } from "../tiling-algorithm-default.ts";
import type { WorkspaceSnapshot, PluginWorkspaceReducer } from "../workspace.ts";
import type { PluginActionRegistration } from "../effect/WorkspaceTransaction.ts";
import type { ResultCodec } from "../workspace-changes.ts";
import type { PaneDescriptorRegistration } from "../pane-descriptors.ts";
import type { ProviderMessageRegistration } from "../session-provider-messages.ts";
import type { DaemonEventPayload } from "../effect/EventBus.ts";
import type { ControlError } from "../control.ts";
import type { DaemonSessions } from "../daemon-sessions.ts";

/** @effect-leakable-service */
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
  readonly resources: (args: any) => readonly string[];
  readonly handler: (args: any) => Effect.Effect<unknown, CommandError>;
}

export interface RegistryService<A> {
  readonly register: (value: A) => Effect.Effect<void, never, CurrentPlugin | Scope.Scope>;
}

/**
 * The plugin-facing single-argument form of `Slots.register`. A
 * discriminated union mirroring its three overloads, so a mismatched
 * slot/occupant pair (an overlay occupant into a dock slot, say) is a
 * compile error at the plugin call site, not a silent runtime misplace.
 */
export type SlotsRegisterValue =
  | { readonly slot: DockSlotName; readonly occupant: DockOccupant; readonly priority?: number }
  | { readonly slot: "overlay"; readonly occupant: OverlayOccupant; readonly priority?: number }
  | { readonly slot: "float"; readonly occupant: FloatOccupant; readonly priority?: number };

export type SlotsService = Omit<Slots, "register"> & {
  readonly register: RegistryService<SlotsRegisterValue>["register"];
};
export type SessionViewsService = Omit<SessionViews, "register"> &
  RegistryService<readonly [string, PaneView]>;
export type ProcessDisplayService = Omit<ProcessDisplay, "register"> &
  RegistryService<ProcessDisplayProvider>;
export type BindingsService = Bindings & RegistryService<CommandSpec>;
export interface ContextsService extends RegistryService<ContextSpec> {
  readonly all: () => readonly ContextSpec[];
  readonly conflicts: () => readonly ContextPriorityConflict[];
}
export interface SettingsService extends RegistryService<PluginSettingsSection> {
  readonly all: () => readonly PluginSettingsSection[];
}
/** A value a plugin contributes to an existing enum option's closed choice —
 *  a tiling-algorithm plugin adding its own id to `behaviour.tilingAlgorithm`,
 *  say — without core needing to name the plugin ahead of time. Extending an
 *  option nobody declared, or one that isn't `kind: "enum"`, is a
 *  registration bug and throws the same way an unintentional slot collision
 *  does (`OptionsService.register` for a whole new option is the sibling
 *  capability this complements). */
export interface EnumValueRegistration {
  readonly option: string;
  readonly value: string;
}

export interface OptionsService extends RegistryService<readonly [string, OptionSpec]> {
  readonly get: (name: string) => OptionSpec | undefined;
  readonly all: () => readonly Contribution<OptionSpec>[];
  readonly registerEnumValue: (
    registration: EnumValueRegistration,
  ) => Effect.Effect<void, never, CurrentPlugin | Scope.Scope>;
  /** Every value a plugin has contributed to `name`'s enum, base values
   *  excluded — callers append this to the declared spec's own `values`. */
  readonly enumValues: (name: string) => readonly string[];
}
export interface SpawnProvidersService extends RegistryService<
  readonly [string, () => SpawnProvider]
> {
  readonly get: (id: string) => SpawnProvider | undefined;
}
export type CommandsService = Omit<Commands, "registerCommand" | "registerFullCommand"> &
  RegistryService<CommandRegistration>;

/**
 * A command a daemon-resident plugin authors: the same authority core's
 * commands.ts has for built-in commands — a full tag (not namespaced), the
 * CLI argument shape, the target classification, and how it executes.
 *
 * Workspace-target commands reduce through the daemon's model queue: `reduce`
 * returns an Effect of workspace changes as data; core applies them
 * synchronously inside the transaction. Session-target commands never touch
 * the model queue: `run` executes directly with a per-call snapshot and reads
 * live session capabilities from {@link DaemonSessions}.
 */
export interface DaemonCommandSpec {
  readonly tag: string;
  readonly fields: S.Struct.Fields;
  readonly meta: Meta;
  readonly resources: (args: any) => readonly string[];
  /** Result Schema closed over as a codec via {@link commandResultCodec}. */
  readonly result?: ResultCodec;
}

export interface DaemonCommandRegistration extends DaemonCommandSpec {
  readonly reduce?: PluginWorkspaceReducer;
  readonly run?: (
    command: RuntimeCommand,
    context: DaemonSessionCommandContext,
  ) => Effect.Effect<unknown, CommandError, DaemonSessions>;
  /** New WorkspaceAction variants this command's reducer may push, with the
   *  executors the transaction routes them to. */
  readonly actions?: readonly PluginActionRegistration[];
  /** Pane-type descriptor codecs this command's plugin owns. */
  readonly paneDescriptors?: readonly PaneDescriptorRegistration[];
  /** Session-provider message codecs this command's plugin owns. */
  readonly providerMessages?: readonly ProviderMessageRegistration[];
}

/** Per-call capabilities for a session-target daemon command. Read-only plus
 *  the live session surface — mutation of daemon-owned model state goes
 *  through workspace-target commands, never through here. */
export interface DaemonSessionCommandContext {
  readonly snapshot: WorkspaceSnapshot;
}

export interface DaemonCommandsService extends RegistryService<DaemonCommandRegistration> {
  readonly all: () => readonly Contribution<DaemonCommandRegistration>[];
}

export interface TilingAlgorithmContext {
  readonly width: number;
  readonly height: number;
  readonly workspaceId?: string;
  readonly sessionCount?: number;
  readonly selectedId: string;
}

export interface TilingAlgorithmRegistration {
  readonly priority: number;
  readonly selector: (ctx: TilingAlgorithmContext) => boolean;
  readonly algorithm: TilingAlgorithm;
}

export interface TilingAlgorithmsService extends RegistryService<TilingAlgorithmRegistration> {
  readonly all: () => readonly Contribution<TilingAlgorithmRegistration>[];
}

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

export class SlotsTag extends Context.Service<SlotsTag, SlotsService>()("amux/Slots") {}
export class SessionViewsTag extends Context.Service<SessionViewsTag, SessionViewsService>()(
  "amux/SessionViews",
) {}
export class ProcessDisplayTag extends Context.Service<ProcessDisplayTag, ProcessDisplayService>()(
  "amux/ProcessDisplay",
) {}
export class BindingsTag extends Context.Service<BindingsTag, BindingsService>()("amux/Bindings") {}
export class ContextsTag extends Context.Service<ContextsTag, ContextsService>()("amux/Contexts") {}
export class SettingsTag extends Context.Service<SettingsTag, SettingsService>()("amux/Settings") {}
export class OptionsTag extends Context.Service<OptionsTag, OptionsService>()("amux/Options") {}
export class SpawnProvidersTag extends Context.Service<SpawnProvidersTag, SpawnProvidersService>()(
  "amux/SpawnProviders",
) {}
export class CommandsTag extends Context.Service<CommandsTag, CommandsService>()("amux/Commands") {}
export class CliCommandsTag extends Context.Service<CliCommandsTag, CliCommandsService>()(
  "amux/CliCommands",
) {}
export class DaemonCommandsTag extends Context.Service<DaemonCommandsTag, DaemonCommandsService>()(
  "amux/DaemonCommands",
) {}
export class TilingAlgorithmsTag extends Context.Service<
  TilingAlgorithmsTag,
  TilingAlgorithmsService
>()("amux/TilingAlgorithms") {}
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

/**
 * The daemon's event stream, brokered across the control socket to whichever
 * client injects this key. Unlike every other tag in this file, the key is
 * not a local capability with a withdrawal guarantee — it crosses a process
 * boundary, and the ordering guarantee that makes a component's teardown safe
 * (a provider waits for every dependent to unwind before it goes) cannot
 * survive a dead peer that never reports it finished. The stream's error
 * channel is therefore not decoration: `ControlError` is what a consumer sees
 * when the daemon dies mid-subscription, and nothing here pretends that looks
 * like a normal service withdrawal (ep-90ed58 point 4).
 */
export interface RemoteEventsService {
  readonly events: Stream.Stream<DaemonEventPayload, ControlError>;
}
export class RemoteEventsTag extends Context.Service<RemoteEventsTag, RemoteEventsService>()(
  "amux/RemoteEvents",
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
  resources: (args: S.Struct.Type<Fields>) => readonly string[],
  handler: (args: S.Struct.Type<Fields>) => Effect.Effect<unknown, CommandError>,
): Effect.Effect<void, never, CommandsTag | CurrentPlugin | Scope.Scope> =>
  CommandsTag.pipe(
    Effect.flatMap((commands) => commands.register({ verb, fields, meta, resources, handler })),
  );

/**
 * Author a daemon-side command: the full tag plus its workspace reducer
 * and/or session runner. The type-safe surface over `DaemonCommandsTag` —
 * a plugin actually calls this, never `register` directly.
 */
export const registerDaemonCommand = (
  registration: DaemonCommandRegistration,
): Effect.Effect<void, never, DaemonCommandsTag | CurrentPlugin | Scope.Scope> =>
  DaemonCommandsTag.pipe(Effect.flatMap((commands) => commands.register(registration)));

/** Contribute a value to an existing enum option's closed choice — the
 *  type-safe surface over `OptionsTag.registerEnumValue` a plugin actually
 *  calls, mirroring `registerDaemonCommand`. */
export const registerEnumValue = (
  registration: EnumValueRegistration,
): Effect.Effect<void, never, OptionsTag | CurrentPlugin | Scope.Scope> =>
  OptionsTag.pipe(Effect.flatMap((options) => options.registerEnumValue(registration)));

export const registerTilingAlgorithm = (
  registration: TilingAlgorithmRegistration,
): Effect.Effect<void, never, TilingAlgorithmsTag | CurrentPlugin | Scope.Scope> =>
  TilingAlgorithmsTag.pipe(Effect.flatMap((algorithms) => algorithms.register(registration)));

export function resolveTilingAlgorithm(
  entries: readonly Contribution<TilingAlgorithmRegistration>[],
  context: TilingAlgorithmContext,
): TilingAlgorithm {
  return (
    [...entries]
      .filter(({ value }) => value.selector(context))
      .sort((left, right) => left.value.priority - right.value.priority)[0]?.value.algorithm ??
    defaultTilingAlgorithm
  );
}

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
  readonly provide: <Id, S>(
    owner: PluginInstance,
    tag: Context.Service<Id, S>,
    service: S,
    realm?: string,
  ) => void;
  readonly withdraw: (owner: PluginInstance, tag: PluginService, realm?: string) => void;
  readonly withdrawAll: (owner: PluginInstance) => void;
  readonly get: <Id, S>(tag: Context.Service<Id, S>) => Option.Option<S>;
  /** Wait until `tag` has a committed provider. Unlike a change stream, this
   *  cannot miss the handoff between observing absence and subscribing. */
  readonly await: <Id, S>(tag: Context.Service<Id, S>) => Effect.Effect<S>;
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
  /**
   * The derived context for one realm — every service committed *into* that
   * realm, keyed by its own tag so a consumer reads `yield* Tag` unchanged.
   *
   * This is Definition 25's `isolate(k, r)` with the paper's derived
   * realization (Definition 23): nothing in the shared table moves, the result
   * is a fresh context, and recovery is discarding it. That is why isolation
   * carries no inverse while `provide` does.
   */
  readonly realmContext: (realm: string) => Context.Context<never>;
}

/**
 * Service instances stage beside the committed provider, just like UI
 * contributions. A replacement becomes readable only when its host generation
 * commits; until then injectors keep the service they already acquired.
 */
export const createPluginServices = Effect.fnUntraced(function* (
  contributions: PluginContributions,
  onChange: (key: string) => void = () => {},
) {
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
  let changed = Deferred.makeUnsafe<void>();

  function slotFor(tagKey: string, realm?: string): Slot {
    const key = slotKey(tagKey, realm);
    let slot = slots.get(key);
    if (!slot) {
      slot = { key, tagKey, realm, provider: undefined, providers: [] };
      slots.set(key, slot);
    }
    return slot;
  }

  function visible(slot: Slot): Provider | undefined {
    return slot.providers.find((provider) => contributions.isCommitted(provider.owner));
  }

  function update(): void {
    const keys: string[] = [];
    for (const slot of slots.values()) {
      const provider = visible(slot);
      if (slot.provider === provider) continue;
      slot.provider = provider;
      // Observers watch coeffect keys, not realms: a pane-scoped provider
      // changing is still "this key changed" to anything tracking the key.
      keys.push(slot.tagKey);
    }
    if (keys.length === 0) return;
    const previous = changed;
    changed = Deferred.makeUnsafe<void>();
    // Publish a whole generation before waking any consumer or observer.
    Deferred.doneUnsafe(previous, Effect.void);
    for (const key of keys) onChange(key);
  }

  /**
   * Every service committed into `realm`, merged into one context keyed by the
   * tags themselves. A realm holding no provider for a tag simply omits it, so
   * a caller that layers this over the global context gets the paper's
   * `rho(k) = k` fallback for free — pane-scoped keys resolve to the pane,
   * everything else to the one shared binding.
   */
  const realmContext = (realm: string): Context.Context<never> => {
    let context = Context.empty();
    for (const slot of slots.values()) {
      if (slot.realm !== realm || slot.provider === undefined) continue;
      context = Context.merge(context, slot.provider.context);
    }
    return context;
  };

  const unsubscribe = contributions.onChange(update);
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  const awaitService = <Id, S>(tag: Context.Service<Id, S>) => {
    const read = () =>
      Option.fromNullishOr(slots.get(tag.key)?.provider).pipe(
        Option.flatMap((provider) => Context.getOption(provider.context, tag)),
      );
    const wait: Effect.Effect<S> = Effect.suspend(() =>
      Option.match(read(), {
        onNone: () => Deferred.await(changed).pipe(Effect.andThen(wait)),
        onSome: Effect.succeed,
      }),
    );
    return wait;
  };

  return {
    provide(owner, tag, service, realm?) {
      const slot = slotFor(tag.key, realm);
      // One provider per (key, realm) — the flat table's rule, transported
      // along rho. Two panes may each provide the same key because they are
      // different realms; two plugins may not, in any one realm.
      const where = realm === undefined ? `'${tag.key}'` : `'${tag.key}' in realm '${realm}'`;
      const conflict = slot.providers.find((provider) => provider.owner.id !== owner.id);
      if (conflict)
        throw new Error(`service ${where} is already provided by '${conflict.owner.id}'`);
      if (slot.providers.some((provider) => sameInstance(provider.owner, owner)))
        throw new Error(`plugin '${owner.id}' provided ${where} twice`);
      slot.providers.push({ owner, context: Context.make(tag, service) });
      update();
    },

    withdraw(owner, tag, realm?) {
      const slot = slots.get(slotKey(tag.key, realm));
      if (!slot) return;
      slot.providers = slot.providers.filter((provider) => !sameInstance(provider.owner, owner));
      update();
    },

    withdrawAll(owner) {
      for (const slot of slots.values()) {
        slot.providers = slot.providers.filter((provider) => !sameInstance(provider.owner, owner));
      }
      update();
    },

    get: <Id, S>(tag: Context.Service<Id, S>) =>
      Option.fromNullishOr(slots.get(tag.key)?.provider).pipe(
        Option.flatMap((provider) => Context.getOption(provider.context, tag)),
      ),

    await: awaitService,

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
        const view = new Map<string, PluginInstance>();
        const required = dependencies.map((dependency) =>
          slotFor(dependencyService(dependency).key),
        );
        while (required.some((slot) => !slot.provider)) {
          yield* Deferred.await(changed);
          // Providers wake waiters inside ctx.provide. Let them finish registering
          // finalizers before capturing the current view and entering plugin code.
          yield* Effect.yieldNow;
        }
        const resolved = dependencies.map((dependency, index) => ({
          dependency,
          provider: required[index]!.provider!,
        }));
        for (const { dependency, provider } of resolved) {
          const tag = dependencyService(dependency);
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

    realmContext,
  } satisfies PluginServices;
});

/**
 * The storage address for a coeffect key under a realm — `rho(k)` made
 * concrete. A key with no realm addresses itself, which is the paper's
 * "a key outside dom(rho) resolves to its own realm", and keeps every
 * unrealmed slot byte-identical to the flat table it replaces.
 */
const slotKey = (tagKey: string, realm: string | undefined): string =>
  realm === undefined ? tagKey : `${realm}\0${tagKey}`;

interface Slot {
  readonly key: string;
  /** The coeffect key `k`, independent of which realm stores it. */
  readonly tagKey: string;
  /** `rho(k)`, or undefined for the key's own realm. */
  readonly realm: string | undefined;
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
