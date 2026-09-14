/**
 * Supervises the plugin-host child beside the daemon.
 *
 * One generation owns spawn, a single RPC client, pings, and stop. The outer
 * loop repeats generations with backoff from a consecutive-failure count that
 * resets when a generation reaches ready. Host failure never touches sessions
 * or the model.
 */
import { fileURLToPath } from "node:url";
import type { FileSink } from "bun";
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Result,
  Schedule,
  Schema as S,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { errorMessage } from "../error-message.ts";
import { formatStderrTail, makeStderrTail } from "../stderr-tail.ts";
import {
  type PluginHostClient,
  type PluginHostBehaviourCalls,
  type PluginPublication,
} from "./client.ts";
import {
  PluginHostError,
  PluginHostRpcs,
  PluginHostSerialization,
  type PluginHostPublishResult,
  type PluginHostStatus,
} from "./rpc.ts";

/** How often the daemon asks the host whether it is still answering. */
export const PLUGIN_HOST_PING_INTERVAL_MS = 1_000;
/** Wall time allowed for one Ping before the host is treated as hung. */
export const PLUGIN_HOST_PING_TIMEOUT_MS = 2_000;
/** Wall time for the first successful Ping after spawn (socket retries included). */
export const PLUGIN_HOST_READY_TIMEOUT_MS = 5_000;
/** Wall time allowed for Load after Ping before the generation fails. */
export const PLUGIN_HOST_LOAD_TIMEOUT_MS = 30_000;
/** First wait after a failed start or forced restart. */
export const PLUGIN_HOST_BACKOFF_INITIAL_MS = 100;
/** Cap on restart backoff so a dead host is retried regularly. */
export const PLUGIN_HOST_BACKOFF_MAX_MS = 5_000;
/** How long Stop may take before we escalate to signals. */
const STOP_RPC_TIMEOUT_MS = 100;
/** How long to wait for exit after SIGTERM / SIGKILL. */
const EXIT_WAIT_MS = 150;

export interface PluginHostSupervisorOptions {
  readonly socketPath: string;
  /** Capability socket path passed to the child as AMUX_PLUGIN_CAPABILITIES_SOCKET. */
  readonly capabilitiesSocketPath: string;
  readonly status: SubscriptionRef.SubscriptionRef<PluginHostStatus>;
  /** Slot for the live publication; cleared by the generation release. */
  readonly generation: SubscriptionRef.SubscriptionRef<
    Option.Option<PluginPublication<PluginHostBehaviourCalls>>
  >;
  /**
   * After Ping succeeds, load plugins for this generation. Failure fails the
   * generation (status failed + backoff restart).
   */
  readonly loadGeneration: (
    client: PluginHostClient,
  ) => Effect.Effect<PluginHostPublishResult, PluginHostError>;
  /** Override the host argv (tests: hang fixture). Default: this package's CLI. */
  readonly argv?: readonly string[];
  readonly pingIntervalMs?: number;
  readonly pingTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly loadTimeoutMs?: number;
  readonly backoffInitialMs?: number;
  readonly backoffMaxMs?: number;
}

class PluginHostConnectError extends S.TaggedError<PluginHostConnectError>()(
  "PluginHostConnectError",
  { message: S.String },
) {}

const notReadyError = () => new PluginHostConnectError({ message: "plugin-host client not ready" });

const defaultArgv = (): readonly string[] => {
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  return [process.execPath, cli, "plugin-host"];
};

const setStatus = (
  status: SubscriptionRef.SubscriptionRef<PluginHostStatus>,
  next: PluginHostStatus,
): Effect.Effect<void> =>
  SubscriptionRef.update(status, (cur) => ({
    ...next,
    lastError: next.lastError ?? cur.lastError,
  }));

type HostChild = {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly kill: (signal?: NodeJS.Signals) => void;
  readonly stderrFormat: () => string;
  /**
   * Write end of the host's stdin pipe. Held open for the child's life and
   * never written; kernel close on daemon death is the host's lifeline EOF.
   */
  readonly stdin: FileSink;
};

const spawnHost = (
  argv: readonly string[],
  socketPath: string,
  capabilitiesSocketPath: string,
): Effect.Effect<HostChild, string, Scope.Scope> =>
  Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn([...argv], {
          env: {
            ...process.env,
            AMUX_PLUGIN_HOST_SOCKET: socketPath,
            AMUX_PLUGIN_CAPABILITIES_SOCKET: capabilitiesSocketPath,
          },
          stdin: "pipe",
          stdout: "ignore",
          stderr: "pipe",
        }),
      catch: (error) => `cannot spawn plugin-host: ${String(error)}`,
    });
    const tail = makeStderrTail();
    yield* tail.drain(child.stderr).pipe(Effect.forkScoped);
    return {
      pid: child.pid,
      exited: child.exited,
      stdin: child.stdin,
      kill: (signal?: NodeJS.Signals) => {
        try {
          child.kill(signal);
        } catch {
          /* already exited */
        }
      },
      stderrFormat: () => formatStderrTail(tail),
    };
  });

const connectHost = (
  socketPath: string,
  readyTimeoutMs: number,
  opened: Deferred.Deferred<void>,
): Effect.Effect<PluginHostClient, PluginHostConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    const retryPolicy = Schedule.exponential("20 millis").pipe(
      Schedule.upTo({ duration: Duration.millis(readyTimeoutMs) }),
    );
    const protocol = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: true,
        retryPolicy,
      }),
    ).pipe(
      Layer.provide(NodeSocket.layerNet({ path: socketPath })),
      Layer.provide(PluginHostSerialization),
      Layer.provide(
        Layer.succeed(RpcClient.ConnectionHooks, {
          onConnect: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
          onDisconnect: Effect.void,
        }),
      ),
    );
    const context = yield* Layer.build(protocol);
    return yield* RpcClient.make(PluginHostRpcs, { disableTracing: true }).pipe(
      Effect.provide(context),
    );
  }).pipe(
    Effect.mapError(
      (error) =>
        new PluginHostConnectError({
          message: errorMessage(error instanceof Error ? error : new Error(String(error))),
        }),
    ),
  );

const describeFailure = (message: string, child?: HostChild): string => {
  const stderr = child?.stderrFormat() ?? "";
  if (stderr) return stderr;
  return message;
};

const waitExited = (child: HostChild, ms: number): Effect.Effect<boolean> =>
  Effect.raceFirst(
    Effect.promise(() => child.exited).pipe(Effect.as(true)),
    Effect.sleep(Duration.millis(ms)).pipe(Effect.as(false)),
  );

/** Prefer the child's exit reason when it has already completed. */
const preferExitReason = (
  exitReason: Deferred.Deferred<string>,
  failure: string,
): Effect.Effect<string> =>
  Deferred.poll(exitReason).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(failure),
        onSome: (get) => get,
      }),
    ),
  );

/**
 * Wait until a live generation is in the slot (for later plugin calls).
 * Subscribes to slot changes; first `Some` within the ready window wins.
 */
export const awaitPluginHostClient = (
  slot: SubscriptionRef.SubscriptionRef<Option.Option<PluginPublication<PluginHostBehaviourCalls>>>,
  readyTimeoutMs = PLUGIN_HOST_READY_TIMEOUT_MS,
): Effect.Effect<PluginHostBehaviourCalls, PluginHostConnectError> =>
  SubscriptionRef.changes(slot).pipe(
    Stream.filterMap((value) => Result.fromOption(value, () => undefined)),
    Stream.take(1),
    Stream.runHead,
    Effect.timeoutOption(Duration.millis(readyTimeoutMs)),
    Effect.map(Option.flatten),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(notReadyError()),
        onSome: (publication) => Effect.succeed(publication.client),
      }),
    ),
  );

/**
 * Wait until the first generation is ready or fails. Subscribes to status;
 * after the first `ready`/`failed` event, reads the generation slot.
 */
export const awaitFirstPluginHostOutcome = (
  slot: SubscriptionRef.SubscriptionRef<Option.Option<PluginPublication<PluginHostBehaviourCalls>>>,
  status: SubscriptionRef.SubscriptionRef<PluginHostStatus>,
): Effect.Effect<Option.Option<PluginPublication<PluginHostBehaviourCalls>>> =>
  Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(status);
    if (current.state === "ready") return yield* SubscriptionRef.get(slot);
    if (current.state === "failed") return Option.none();

    const terminal = yield* SubscriptionRef.changes(status).pipe(
      Stream.filter((s) => s.state === "ready" || s.state === "failed"),
      Stream.take(1),
      Stream.runHead,
    );
    return yield* Option.match(terminal, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (s) =>
        s.state === "failed" ? Effect.succeed(Option.none()) : SubscriptionRef.get(slot),
    });
  });

type GenerationResult = {
  readonly reason: string;
  readonly reachedReady: boolean;
};

/**
 * One host generation: spawn, one reconnecting RPC client, ping until failure.
 *
 * Connect/watch fibers are forked into the connection scope. Release kills the
 * child, then closes that scope so those fibers interrupt after the peer is gone.
 */
const runGeneration = (
  options: PluginHostSupervisorOptions,
  restarts: number,
): Effect.Effect<GenerationResult, never, Scope.Scope> =>
  Effect.gen(function* () {
    const argv = options.argv ?? defaultArgv();
    const pingTimeoutMs = options.pingTimeoutMs ?? PLUGIN_HOST_PING_TIMEOUT_MS;
    const pingIntervalMs = options.pingIntervalMs ?? PLUGIN_HOST_PING_INTERVAL_MS;
    const readyTimeoutMs = options.readyTimeoutMs ?? PLUGIN_HOST_READY_TIMEOUT_MS;

    const childResult = yield* spawnHost(
      argv,
      options.socketPath,
      options.capabilitiesSocketPath,
    ).pipe(Effect.result);
    if (childResult._tag === "Failure") {
      yield* setStatus(options.status, {
        state: "failed",
        restarts,
        lastError: childResult.failure,
      });
      return { reason: childResult.failure, reachedReady: false };
    }
    const child = childResult.success;

    yield* setStatus(options.status, {
      state: restarts === 0 ? "starting" : "restarting",
      restarts,
      pid: child.pid,
    });

    const connectionScope = yield* Scope.make();
    const done = yield* Deferred.make<GenerationResult>();
    const exitReason = yield* Deferred.make<string>();
    const reachedReady = yield* Ref.make(false);

    const failBeforeReady = Effect.fnUntraced(function* (failure: string) {
      // Transport errors from a dying peer often land before the exit watcher
      // completes; wait briefly so lastError names the child exit when it can.
      const reason = yield* Deferred.await(exitReason).pipe(
        Effect.timeoutOption(Duration.millis(100)),
        Effect.flatMap(
          Option.match({
            onNone: () => preferExitReason(exitReason, failure),
            onSome: (exit) => Effect.succeed(exit),
          }),
        ),
      );
      yield* setStatus(options.status, {
        state: "failed",
        restarts,
        lastError: reason,
        pid: child.pid,
      });
      yield* Deferred.succeed(done, { reason, reachedReady: false });
    });

    const failAfterReady = Effect.fnUntraced(function* (failure: string) {
      const reason = yield* preferExitReason(exitReason, failure);
      yield* setStatus(options.status, {
        state: "failed",
        restarts,
        lastError: reason,
        pid: child.pid,
      });
      yield* Deferred.succeed(done, { reason, reachedReady: true });
    });

    yield* Effect.forkIn(
      Effect.promise(() => child.exited).pipe(
        Effect.map((code) => {
          const stderr = child.stderrFormat();
          return stderr || `plugin-host exited with code ${code}`;
        }),
        Effect.flatMap((reason) => Deferred.succeed(exitReason, reason)),
      ),
      connectionScope,
    );

    yield* Effect.forkIn(
      Effect.gen(function* () {
        const opened = yield* Deferred.make<void>();
        const clientResult = yield* connectHost(options.socketPath, readyTimeoutMs, opened).pipe(
          Scope.provide(connectionScope),
          Effect.mapError((error) => describeFailure(errorMessage(error), child)),
          Effect.result,
        );
        if (clientResult._tag === "Failure") {
          return yield* failBeforeReady(clientResult.failure);
        }
        const client = clientResult.success;

        // Wait for the transport to open before Ping. An in-flight Ping against
        // a socket that never opened leaves Interrupt stuck on the write latch.
        const openedResult = yield* Effect.raceFirst(
          Deferred.await(opened).pipe(Effect.as(true)),
          Deferred.await(exitReason).pipe(Effect.as(false)),
        ).pipe(
          Effect.timeout(Duration.millis(readyTimeoutMs)),
          Effect.mapError((error) => describeFailure(errorMessage(error), child)),
          Effect.result,
        );
        if (openedResult._tag === "Failure") {
          return yield* failBeforeReady(openedResult.failure);
        }
        if (!openedResult.success) {
          return yield* failBeforeReady("plugin-host exited before the control socket opened");
        }

        const ready = yield* Effect.raceFirst(
          client.Ping().pipe(
            Effect.timeout(Duration.millis(readyTimeoutMs)),
            Effect.mapError((error) => describeFailure(errorMessage(error), child)),
            Effect.result,
          ),
          Deferred.await(exitReason).pipe(Effect.map((reason) => Result.fail(reason))),
        );
        if (ready._tag === "Failure") {
          return yield* failBeforeReady(ready.failure);
        }

        const loadTimeoutMs = options.loadTimeoutMs ?? PLUGIN_HOST_LOAD_TIMEOUT_MS;
        const loaded = yield* Effect.raceFirst(
          options.loadGeneration(client).pipe(
            Effect.timeout(Duration.millis(loadTimeoutMs)),
            Effect.mapError((error) =>
              describeFailure(
                S.is(PluginHostError)(error) ? error.message : errorMessage(error),
                child,
              ),
            ),
            Effect.result,
          ),
          Deferred.await(exitReason).pipe(Effect.map((reason) => Result.fail(reason))),
        );
        if (loaded._tag === "Failure") {
          return yield* failBeforeReady(loaded.failure);
        }

        yield* SubscriptionRef.set(
          options.generation,
          Option.some({
            client,
            revision: loaded.success.revision,
            declarations: loaded.success.declarations,
          }),
        );
        yield* setStatus(options.status, { state: "ready", restarts, pid: child.pid });
        yield* Ref.set(reachedReady, true);

        const pingFailed = yield* Deferred.make<string>();
        yield* Effect.forkIn(
          Effect.forever(
            Effect.sleep(Duration.millis(pingIntervalMs)).pipe(
              Effect.andThen(client.Ping().pipe(Effect.timeout(Duration.millis(pingTimeoutMs)))),
            ),
          ).pipe(
            Effect.catch((error) =>
              Deferred.succeed(pingFailed, describeFailure(errorMessage(error), child)).pipe(
                Effect.asVoid,
              ),
            ),
          ),
          connectionScope,
        );

        const reason = yield* Effect.raceFirst(
          Deferred.await(exitReason),
          Deferred.await(pingFailed),
        );
        yield* failAfterReady(reason);
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.gen(function* () {
            const ready = yield* Ref.get(reachedReady);
            const failure = describeFailure(errorMessage(defect), child);
            if (ready) yield* failAfterReady(failure);
            else yield* failBeforeReady(failure);
          }),
        ),
        Effect.asVoid,
      ),
      connectionScope,
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const live = yield* SubscriptionRef.get(options.generation);
        yield* Option.match(live, {
          onNone: () => Effect.void,
          onSome: (publication) =>
            publication.client
              .Stop()
              .pipe(Effect.timeoutOption(Duration.millis(STOP_RPC_TIMEOUT_MS)), Effect.ignore),
        });
        child.kill("SIGTERM");
        const afterTerm = yield* waitExited(child, EXIT_WAIT_MS);
        if (!afterTerm) child.kill("SIGKILL");
        yield* waitExited(child, EXIT_WAIT_MS).pipe(Effect.asVoid);
        yield* Scope.close(connectionScope, Exit.void);
        yield* SubscriptionRef.set(options.generation, Option.none());
      }).pipe(Effect.asVoid),
    );

    return yield* Deferred.await(done);
  });

/**
 * Supervise the plugin-host for the enclosing scope. Closing the scope closes
 * the current generation (and its release stops the child).
 */
export const supervisePluginHost = (
  options: PluginHostSupervisorOptions,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const restarts = yield* Ref.make(0);
    const consecutiveFailures = yield* Ref.make(0);
    const backoffInitial = options.backoffInitialMs ?? PLUGIN_HOST_BACKOFF_INITIAL_MS;
    const backoffMax = options.backoffMaxMs ?? PLUGIN_HOST_BACKOFF_MAX_MS;

    return yield* Effect.forever(
      Effect.gen(function* () {
        const n = yield* Ref.get(restarts);
        const result = yield* Effect.scoped(runGeneration(options, n));
        yield* Ref.update(restarts, (x) => x + 1);
        if (result.reachedReady) {
          yield* Ref.set(consecutiveFailures, 0);
        } else {
          yield* Ref.update(consecutiveFailures, (x) => x + 1);
        }
        const streak = yield* Ref.get(consecutiveFailures);
        const exp = result.reachedReady ? 0 : Math.max(0, streak - 1);
        const delayMs = Math.min(backoffInitial * 2 ** exp, backoffMax);
        yield* Effect.sleep(Duration.millis(delayMs));
      }),
    );
  }).pipe(Effect.interruptible, Effect.asVoid);
