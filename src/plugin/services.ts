import { Context, Deferred, Effect, FiberId, Option } from "effect";

/**
 * What plugins trade in: a service under an Effect tag, published by one plugin
 * and injected by others.
 *
 * A tag is the key because it already carries the service's type. Nothing here
 * resolves a dependency graph by hand — a plugin that injects a tag suspends on
 * that tag's Deferred, and the plugin that provides it resolves the Deferred.
 * Activation order therefore falls out of who provides what, not out of the
 * order plugins were configured in.
 */
export type PluginService = Context.Tag<any, any>;

export interface PluginServices {
  /**
   * Publish `service` under `tag`. Throws if the tag already has a provider:
   * two implementations of one tag would make "the provider of X" ambiguous,
   * and the injector could not be told which one it got.
   */
  readonly provide: <Id, S>(owner: string, tag: Context.Tag<Id, S>, service: S) => void;
  readonly withdraw: (owner: string, tag: PluginService) => void;
  /** Withdraw everything `owner` published, for a provider that is going away. */
  readonly withdrawAll: (owner: string) => void;
  /** A soft read of whoever provides `tag` right now. Do not hold the result:
   *  a provider can leave, and only a declared inject makes the host wait. */
  readonly get: <Id, S>(tag: Context.Tag<Id, S>) => Option.Option<S>;
  /** Record what `pluginId` cannot run without, so a withdrawal knows whom it affects. */
  readonly declare: (pluginId: string, tags: readonly PluginService[]) => void;
  readonly forget: (pluginId: string) => void;
  /** Suspends until every declared tag has a provider, then hands back their context. */
  readonly awaitAll: <R>(tags: readonly PluginService[]) => Effect.Effect<Context.Context<R>>;
  /** The tags `pluginId` declared that nobody provides yet — why it has not started. */
  readonly waitingOn: (pluginId: string) => readonly string[];
  /** Plugins that injected a tag `owner` currently provides. */
  readonly dependentsOf: (owner: string) => readonly string[];
}

export function createPluginServices(): PluginServices {
  const slots = new Map<string, Slot>();
  const injects = new Map<string, readonly PluginService[]>();

  /** The waiting room for a tag, whether or not anyone provides it yet. */
  function slotFor(key: string): Slot {
    let slot = slots.get(key);
    if (!slot) {
      slot = { deferred: Deferred.unsafeMake(FiberId.none), provider: null };
      slots.set(key, slot);
    }
    return slot;
  }

  /**
   * A fresh Deferred re-arms the waiting room: a plugin that injects this tag
   * after the withdrawal suspends again instead of reading the value the last
   * provider left resolved there.
   */
  function release(owner: string, slot: Slot): void {
    if (slot.provider?.owner !== owner) return;
    slot.provider = null;
    slot.deferred = Deferred.unsafeMake(FiberId.none);
  }

  return {
    provide(owner, tag, service) {
      const slot = slotFor(tag.key);
      if (slot.provider)
        throw new Error(`service '${tag.key}' is already provided by '${slot.provider.owner}'`);
      slot.provider = { owner, service };
      Deferred.unsafeDone(slot.deferred, Effect.succeed(service));
    },

    withdraw(owner, tag) {
      const slot = slots.get(tag.key);
      if (slot) release(owner, slot);
    },

    withdrawAll(owner) {
      for (const slot of slots.values()) release(owner, slot);
    },

    get: <Id, S>(tag: Context.Tag<Id, S>) =>
      Option.fromNullable(slots.get(tag.key)?.provider).pipe(
        Option.map((provider) => provider.service as S),
      ),

    declare(pluginId, tags) {
      injects.set(pluginId, tags);
    },

    forget(pluginId) {
      injects.delete(pluginId);
    },

    awaitAll: <R>(tags: readonly PluginService[]) =>
      Effect.gen(function* () {
        let context = Context.empty();
        for (const tag of tags) {
          const service = yield* Deferred.await(slotFor(tag.key).deferred);
          context = Context.add(context, tag, service);
        }
        // The host provides this context to the effect the tags were declared
        // for, so the identifiers it carries are exactly that effect's.
        return context as Context.Context<R>;
      }),

    waitingOn: (pluginId) =>
      (injects.get(pluginId) ?? [])
        .filter((tag) => !slots.get(tag.key)?.provider)
        .map((tag) => tag.key),

    dependentsOf(owner) {
      const provided = new Set(
        [...slots].filter(([, slot]) => slot.provider?.owner === owner).map(([key]) => key),
      );
      if (provided.size === 0) return [];
      return [...injects]
        .filter(([, tags]) => tags.some((tag) => provided.has(tag.key)))
        .map(([pluginId]) => pluginId);
    },
  };
}

interface Slot {
  /** Resolved while the tag has a provider; replaced when that provider leaves. */
  deferred: Deferred.Deferred<unknown>;
  provider: { readonly owner: string; readonly service: unknown } | null;
}
