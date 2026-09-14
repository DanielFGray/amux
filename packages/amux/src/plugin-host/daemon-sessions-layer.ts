/**
 * Plugin-host implementation of DaemonSessions over the capability socket.
 *
 * Connects on first use; one connection lives for the layer's scope. Transport
 * and decode failures become DaemonSessionsError naming the capability socket.
 */
import {
  Config,
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Ref,
  Schema as S,
  Scope,
  Semaphore,
} from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcClient from "effect/unstable/rpc/RpcClient";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import {
  DaemonSessions,
  DaemonSessionsError,
  type DaemonSessionsService,
} from "../daemon-sessions.ts";
import { connectRpcPath } from "../control-client.ts";
import { errorMessage } from "../error-message.ts";
import { DaemonSessionsRpcs, DaemonSessionsSerialization } from "./capabilities-rpc.ts";

type CapabilitiesClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof DaemonSessionsRpcs>,
  RpcClientError
>;

const toSessionsError = (socket: string, message: string): DaemonSessionsError =>
  new DaemonSessionsError({
    message: `plugin capabilities socket ${socket}: ${message}`,
  });

const preserveSessionsError =
  (socket: string) =>
  (error: DaemonSessionsError | RpcClientError): DaemonSessionsError =>
    S.is(DaemonSessionsError)(error) ? error : toSessionsError(socket, errorMessage(error));

/**
 * Map RpcClientError failures and transport defects to DaemonSessionsError.
 * Interrupts propagate; a DaemonSessionsError from the daemon is unchanged.
 */
const asSessionsFailure =
  (socket: string) =>
  <A>(effect: Effect.Effect<A, DaemonSessionsError | RpcClientError>) =>
    effect.pipe(
      Effect.mapError(preserveSessionsError(socket)),
      Effect.catchDefect((defect) => Effect.fail(toSessionsError(socket, errorMessage(defect)))),
    );

/**
 * DaemonSessions over a known capability socket path. Connects on first use;
 * one connection lives for the layer's scope.
 */
export const daemonSessionsFromCapabilitiesSocket = (socket: string): Layer.Layer<DaemonSessions> =>
  Layer.effect(
    DaemonSessions,
    Effect.gen(function* () {
      // Capture the layer scope so a first-use connect does not leave Scope on
      // every DaemonSessions method.
      const scope = yield* Scope.Scope;
      const slot = yield* Ref.make(Option.none<CapabilitiesClient>());
      // One permit: concurrent first calls must not open two connections.
      const connectLock = yield* Semaphore.make(1);

      const getClient: Effect.Effect<CapabilitiesClient, DaemonSessionsError> =
        connectLock.withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* Ref.get(slot);
            if (Option.isSome(existing)) return existing.value;
            const client = yield* connectRpcPath(
              socket,
              DaemonSessionsRpcs,
              DaemonSessionsSerialization,
              (message) => toSessionsError(socket, message),
            ).pipe(Scope.provide(scope));
            yield* Ref.set(slot, Option.some(client));
            return client;
          }),
        );

      const service: DaemonSessionsService = {
        message: (id, message) =>
          asSessionsFailure(socket)(
            getClient.pipe(Effect.flatMap((client) => client.Message({ id, message }))),
          ),
        prompt: (target, text, options) =>
          asSessionsFailure(socket)(
            getClient.pipe(
              Effect.flatMap((client) =>
                options === undefined
                  ? client.Prompt({ target, text })
                  : client.Prompt({ target, text, options }),
              ),
            ),
          ),
        capture: (session) =>
          asSessionsFailure(socket)(
            getClient.pipe(Effect.flatMap((client) => client.Capture({ session }))),
          ),
      };
      return service;
    }),
  );

/**
 * Reads `AMUX_PLUGIN_CAPABILITIES_SOCKET` from config and serves DaemonSessions
 * over that socket.
 */
export const DaemonSessionsFromCapabilities: Layer.Layer<
  DaemonSessions,
  Config.ConfigError,
  ConfigProvider.ConfigProvider
> = Layer.unwrap(
  Effect.map(
    Config.string("AMUX_PLUGIN_CAPABILITIES_SOCKET"),
    daemonSessionsFromCapabilitiesSocket,
  ),
);
