/**
 * SocketServer wrapper that admits connections by peer credentials.
 *
 * The control socket, plugin-host socket, and plugin-capabilities socket all
 * share this shape: refuse unidentified peers, and swallow SocketReadError so
 * a client hangup is not a server failure.
 */
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import { Cause, Effect, Option } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import type { PeerCredentials } from "./peer-credentials.ts";
import { peerCredentials, socketFd } from "./peer-credentials.ts";

/** Decide whether a peer may use this socket. Effect so callers can read live state. */
export type PeerAdmission = (peer: PeerCredentials | null) => Effect.Effect<boolean>;

/**
 * Wrap a NodeSocketServer so each connection is admitted by `admit` before the
 * handler runs. `NetSocket` is placed in the connection's context by the node
 * socket server but absent from `run`'s signature, so it is read as an option.
 * Absent means the peer cannot be identified, which is refused for the same
 * reason an unreadable credential set is.
 */
export const peerCheckedSocketServer = (
  socketServer: SocketServer.SocketServer["Service"],
  admit: PeerAdmission,
): SocketServer.SocketServer["Service"] =>
  SocketServer.SocketServer.of({
    ...socketServer,
    run: (handler) =>
      socketServer.run((socket) =>
        Effect.gen(function* () {
          const conn = yield* Effect.serviceOption(NodeSocket.NetSocket);
          const peer = Option.isNone(conn) ? null : peerCredentials(socketFd(conn.value));
          const admitted = yield* admit(peer);
          if (!admitted) {
            return yield* Effect.sync(() => {
              if (Option.isSome(conn)) conn.value.destroy();
            });
          }
          return yield* handler(socket).pipe(
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause);
              return Socket.SocketError.is(error) && error.reason._tag === "SocketReadError"
                ? Effect.void
                : Effect.failCause(cause);
            }),
          );
        }),
      ),
  });
