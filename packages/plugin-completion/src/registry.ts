import { Context, Effect, Scope } from "effect";
import { createSignal } from "solid-js";
import { CurrentPlugin } from "@danielfgray/amux";
import type { PluginInstance } from "@danielfgray/amux/plugin/contributions.ts";
import type { CompletionItem, CompletionSource, CompletionTrigger } from "./types.ts";

/** A source plus the plugin that registered it. The owner is what retires it. */
export interface SourcedCompletion {
  readonly owner: PluginInstance;
  readonly source: CompletionSource;
}

export interface CompletionSourcesService {
  /** Every live source. Signal-backed: a commit repaints consumers. */
  readonly all: () => readonly SourcedCompletion[];
  readonly forTrigger: (trigger: CompletionTrigger) => readonly SourcedCompletion[];
  /**
   * Contribute a source. Withdrawn with the registering plugin's scope —
   * the same owner-scoped lifetime `scopedRegistry` gives host registries,
   * minus the host commit gate: entries are visible as soon as they arrive.
   * A reloading plugin briefly doubles its sources until the old scope
   * closes; `completeFrom` dedupes that overlap by owner and trigger.
   */
  readonly register: (
    source: CompletionSource,
  ) => Effect.Effect<void, never, CurrentPlugin | Scope.Scope>;
}

export class CompletionSourcesTag extends Context.Service<
  CompletionSourcesTag,
  CompletionSourcesService
>()("amux/CompletionSources") {}

/** The type-safe surface over `CompletionSourcesTag` a plugin actually calls. */
export const registerCompletionSource = (
  source: CompletionSource,
): Effect.Effect<void, never, CompletionSourcesTag | CurrentPlugin | Scope.Scope> =>
  CompletionSourcesTag.pipe(Effect.flatMap((sources) => sources.register(source)));

/**
 * Build the registry. The plugin owns the signal; the host never sees this
 * table, so there is no commit gate — see `register` for the reload caveat.
 */
export const makeCompletionSources = (): CompletionSourcesService => {
  const [entries, setEntries] = createSignal<readonly SourcedCompletion[]>([]);
  return {
    all: entries,
    forTrigger: (trigger) => entries().filter((entry) => entry.source.trigger === trigger),
    register: (source) =>
      Effect.gen(function* () {
        const owner = yield* CurrentPlugin;
        const scope = yield* Scope.Scope;
        const entry: SourcedCompletion = { owner, source };
        setEntries((current) => [...current, entry]);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => void dispose()),
        );
        function dispose() {
          setEntries((current) => current.filter((registered) => registered !== entry));
        }
      }),
  };
};

/**
 * Run every live source for the trigger and merge the items. One failing
 * source yields nothing rather than killing the menu: a broken file index
 * must not hide the slash commands. Same-owner, same-id duplicates — the
 * reload overlap — collapse to the latest registration.
 */
export const completeFrom = (
  service: Pick<CompletionSourcesService, "forTrigger">,
  trigger: CompletionTrigger,
  query: string,
): Promise<readonly CompletionItem[]> => {
  const seen = new Set<string>();
  const sources = service
    .forTrigger(trigger)
    .slice()
    .reverse()
    .filter((entry) => {
      const key = `${entry.owner.id} ${entry.source.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return Promise.all(
    sources.map((entry) =>
      Promise.resolve()
        .then(() => entry.source.complete(query))
        .catch(() => [] as const),
    ),
  ).then((lists) => lists.flat());
};
