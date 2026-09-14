/**
 * Plugin-host process: bind the unix socket and serve a handler layer.
 *
 * The entry builds handlers via a factory; fixtures pass their own.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer";
import { Cause, Config, Deferred, Effect, Layer, Option, Scope, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import { isSameUserPeer, socketFd } from "../peer-credentials.ts";
import { PluginHostRpcs, PluginHostSerialization, type PluginHostHandlers } from "./rpc.ts";

const removeStaleSocket = (path: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .remove(path)
      .pipe(
        Effect.catchTag("PlatformError", (e) =>
          e.reason._tag === "NotFound" ? Effect.void : Effect.die(e),
        ),
      );
  });

/**
 * Serve `handlers` on `socketPath` until the enclosing scope closes.
 *
 * Callers that want a clean Stop exit race this effect with a Deferred their
 * Stop handler completes.
 */
export const runPluginHost = (
  socketPath: string,
  handlers: PluginHostHandlers,
): Effect.Effect<void, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    yield* removeStaleSocket(socketPath);

    const socketServer = yield* NodeSocketServer.make({ path: socketPath });
    const hostSocketServer = SocketServer.SocketServer.of({
      ...socketServer,
      run: (handler) =>
        socketServer.run((socket) =>
          Effect.flatMap(Effect.serviceOption(NodeSocket.NetSocket), (conn) =>
            Option.isNone(conn) || !isSameUserPeer(socketFd(conn.value))
              ? Effect.sync(() => {
                  if (Option.isSome(conn)) conn.value.destroy();
                })
              : handler(socket).pipe(
                  Effect.catchCause((cause) => {
                    const error = Cause.squash(cause);
                    return Socket.SocketError.is(error) && error.reason._tag === "SocketReadError"
                      ? Effect.void
                      : Effect.failCause(cause);
                  }),
                ),
          ),
        ),
    });

    yield* Layer.build(
      RpcServer.layer(PluginHostRpcs, { disableTracing: true }).pipe(
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(PluginHostSerialization),
        Layer.provide(Layer.succeed(SocketServer.SocketServer, hostSocketServer)),
        Layer.provide(handlers),
      ),
    );

    return yield* Effect.never;
  }).pipe(
    Effect.catchCause((cause) => Effect.die(Cause.squash(cause))),
    Effect.asVoid,
  );

/** Default Ping/Stop handlers; Stop completes `stopped`. */
export const defaultPluginHostHandlers = (stopped: Deferred.Deferred<void>): PluginHostHandlers =>
  PluginHostRpcs.toLayer({
    Ping: () => Effect.void,
    Stop: () => Effect.forkDetach(Deferred.succeed(stopped, undefined)).pipe(Effect.asVoid),
  });

export type PluginHostHandlerFactory = (stopped: Deferred.Deferred<void>) => PluginHostHandlers;

/**
 * Completes when the supervisor's stdin write end closes (daemon process gone)
 * or when a read errors. Same clean exit path as Stop: the server scope closes.
 */
const awaitDaemonGone: Effect.Effect<void> = Stream.fromAsyncIterable(
  Bun.stdin.stream(),
  (error) => error,
).pipe(Stream.runDrain, Effect.asVoid, Effect.ignore);

/** Entry: read the socket env, build handlers, race Stop / daemon-loss against the server. */
export const runPluginHostMain = (
  handlers: PluginHostHandlerFactory = defaultPluginHostHandlers,
): void => {
  const program = Effect.gen(function* () {
    const socket = Option.getOrUndefined(
      yield* Config.option(Config.string("AMUX_PLUGIN_HOST_SOCKET")),
    );
    if (!socket) {
      return yield* Effect.die("AMUX_PLUGIN_HOST_SOCKET is required");
    }
    const stopped = yield* Deferred.make<void>();
    yield* Effect.raceAll([
      runPluginHost(socket, handlers(stopped)),
      Deferred.await(stopped),
      awaitDaemonGone,
    ]);
  });

  BunRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(BunServices.layer)));
};

if (import.meta.main) {
  runPluginHostMain();
}
