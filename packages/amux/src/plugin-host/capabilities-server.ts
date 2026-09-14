/**
 * Bind and serve DaemonSessions over a peer-checked Unix socket.
 *
 * Shared by the daemon and the capability tests so the admission path is one
 * builder, not a copy.
 */
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer";
import { Effect, Layer, type Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import type { DaemonSessionsService } from "../daemon-sessions.ts";
import { peerCheckedSocketServer, type PeerAdmission } from "../peer-checked-socket-server.ts";
import { removeStaleSocket } from "../remove-stale-socket.ts";
import { DaemonSessionsRpcs, DaemonSessionsSerialization } from "./capabilities-rpc.ts";

/**
 * Remove any stale file at `path`, bind a peer-checked listener in the current
 * scope, and serve DaemonSessions. Returns once listen has succeeded; the
 * server stays up until the scope closes. Bind failures surface as
 * SocketServerError (same channel as NodeSocketServer.make).
 */
export const serveDaemonSessions = (
  path: string,
  service: DaemonSessionsService,
  admit: PeerAdmission,
): Effect.Effect<void, SocketServer.SocketServerError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    yield* removeStaleSocket(path);
    const socketServer = yield* NodeSocketServer.make({ path });
    const checked = peerCheckedSocketServer(socketServer, admit);
    yield* Layer.build(
      RpcServer.layer(DaemonSessionsRpcs, { disableTracing: true }).pipe(
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(DaemonSessionsSerialization),
        Layer.provide(Layer.succeed(SocketServer.SocketServer, checked)),
        Layer.provide(
          DaemonSessionsRpcs.toLayer({
            Message: ({ id, message }) => service.message(id, message),
            Prompt: ({ target, text, options }) => service.prompt(target, text, options),
            Capture: ({ session }) => service.capture(session),
          }),
        ),
      ),
    );
  }).pipe(Effect.asVoid);
