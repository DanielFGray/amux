import { Effect, Queue, Scope, Stream } from "effect";
import type { ProcessState } from "./process-state.ts";
import type { ProcessStateSource } from "./process-state-arbiter.ts";
import type { ScreenRegion } from "./screen-regions.ts";

export const SESSION_FACTS_REFRESH_MS = 250;

export interface ForegroundProcessFact {
  readonly pid: number;
  readonly argv: readonly string[];
}

export interface SessionFact {
  readonly id: string;
  readonly revision: number;
  readonly lifecycle: "running" | "detached" | "exited";
  readonly exitCode: number | null;
  readonly processState: ProcessState | null;
  readonly command: readonly string[];
  readonly declaredAgent: string | null;
  readonly foreground: ForegroundProcessFact | null;
  readonly outputRevision: number;
  readonly screenRevision: number;
  readonly regions: Readonly<Record<string, string>>;
}

export type SessionFactsSnapshot = Readonly<Record<string, SessionFact>>;

export interface SessionFactsInvalidation {
  readonly session: string;
  readonly revision: number;
}

export interface SessionFactsObservation {
  readonly current: () => SessionFactsSnapshot;
  readonly invalidations: Stream.Stream<SessionFactsInvalidation>;
}

export interface SessionFactsService {
  /** Observe the requested grid regions until the caller's scope closes. */
  readonly observe: (
    regions: readonly ScreenRegion[],
  ) => Effect.Effect<SessionFactsObservation, never, Scope.Scope>;
  readonly registerStateSource: (
    session: string,
    source: ProcessStateSource,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

interface SessionFactSource {
  readonly id: string;
  readonly exited: boolean;
  readonly detached: boolean;
  readonly exitCode: number | null;
  readonly reportedState: ProcessState | null;
  readonly cmd: readonly string[];
  readonly declaredAgent: string | null;
  readonly foregroundProcess: ForegroundProcessFact | null;
  readonly outputRevision: number;
  readonly screenRegion: (region: ScreenRegion) => string;
  readonly registerStateSource: (source: ProcessStateSource) => () => void;
}

interface Observer {
  readonly regions: readonly ScreenRegion[];
  readonly queue: Queue.Queue<SessionFactsInvalidation>;
  snapshot: SessionFactsSnapshot;
  nextRevision: number;
}

interface StateBinding {
  readonly session: string;
  readonly stateSource: ProcessStateSource;
  bound?: SessionFactSource;
  unregister?: () => void;
}

const sameFact = (left: SessionFact, right: SessionFact): boolean =>
  left.lifecycle === right.lifecycle &&
  left.exitCode === right.exitCode &&
  left.processState === right.processState &&
  JSON.stringify(left.command) === JSON.stringify(right.command) &&
  left.declaredAgent === right.declaredAgent &&
  left.outputRevision === right.outputRevision &&
  left.screenRevision === right.screenRevision &&
  left.foreground?.pid === right.foreground?.pid &&
  JSON.stringify(left.foreground?.argv ?? []) === JSON.stringify(right.foreground?.argv ?? []) &&
  JSON.stringify(left.regions) === JSON.stringify(right.regions);

const capture = (
  source: SessionFactSource,
  regions: readonly ScreenRegion[],
  revision: number,
): SessionFact => {
  const values = Object.fromEntries(regions.map((region) => [region, source.screenRegion(region)]));
  const foreground = source.foregroundProcess;
  return Object.freeze({
    id: source.id,
    revision,
    lifecycle: source.exited ? "exited" : source.detached ? "detached" : "running",
    exitCode: source.exitCode,
    processState: source.reportedState,
    command: Object.freeze([...source.cmd]),
    declaredAgent: source.declaredAgent,
    foreground:
      foreground === null
        ? null
        : Object.freeze({ pid: foreground.pid, argv: Object.freeze([...foreground.argv]) }),
    outputRevision: source.outputRevision,
    screenRevision: source.outputRevision,
    regions: Object.freeze(values),
  });
};

export const makeSessionFacts = (
  sources: () => readonly SessionFactSource[],
): SessionFactsService => {
  const observers = new Set<Observer>();
  const bindings = new Set<StateBinding>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const refreshBindings = (): void => {
    const current = new Map(sources().map((source) => [source.id, source]));
    for (const binding of bindings) {
      const source = current.get(binding.session);
      if (source === binding.bound) continue;
      binding.unregister?.();
      binding.bound = source;
      binding.unregister = source?.registerStateSource(binding.stateSource);
    }
  };

  const scan = (observer: Observer, notify: boolean): void => {
    const previous = observer.snapshot;
    const next: Record<string, SessionFact> = {};
    for (const source of sources()) {
      const prior = previous[source.id];
      const candidate = capture(source, observer.regions, prior?.revision ?? observer.nextRevision);
      if (prior && sameFact(prior, candidate)) {
        next[source.id] = prior;
        continue;
      }
      const revision = observer.nextRevision++;
      next[source.id] = capture(source, observer.regions, revision);
      if (notify) Queue.offerUnsafe(observer.queue, { session: source.id, revision });
    }
    if (notify) {
      for (const id of Object.keys(previous)) {
        if (next[id]) continue;
        Queue.offerUnsafe(observer.queue, { session: id, revision: observer.nextRevision++ });
      }
    }
    observer.snapshot = Object.freeze(next);
  };

  const stop = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  return {
    registerStateSource: (session, stateSource) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const binding: StateBinding = { session, stateSource };
        bindings.add(binding);
        refreshBindings();
        yield* Scope.addFinalizer(scope, Effect.sync(() => {
          bindings.delete(binding);
          binding.unregister?.();
        }));
      }),
    observe: (regions) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const queue = yield* Queue.unbounded<SessionFactsInvalidation>();
        const observer: Observer = {
          regions: Object.freeze([...new Set(regions)]),
          queue,
          snapshot: Object.freeze({}),
          nextRevision: 1,
        };
        scan(observer, false);
        observers.add(observer);
        if (timer === null) {
          timer = setInterval(() => {
            refreshBindings();
            for (const active of observers) scan(active, true);
          }, SESSION_FACTS_REFRESH_MS);
          timer.unref?.();
        }
        yield* Scope.addFinalizer(scope, Effect.sync(() => {
          observers.delete(observer);
          if (observers.size === 0) stop();
        }));
        return {
          current: () => observer.snapshot,
          invalidations: Stream.fromQueue(queue),
        };
      }),
  };
};
