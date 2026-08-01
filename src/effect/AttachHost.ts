/**
 * The daemon's data plane, assembled and given a lifetime.
 *
 * Every piece of this existed already — the hub fans frames out, the registry
 * owns PTYs, the supervisor pumps them, the server speaks the protocol over a
 * socket — but nothing put them in one scope and nothing decided how long that
 * scope lives. This does, and the answer is: as long as the daemon.
 *
 * That answer is the whole point of the daemon. `PtySupervisor.spawn` requires
 * a Scope, and *which* scope it gets is the difference between a multiplexer
 * and a terminal grid: give it a client's scope and every agent dies when the
 * UI disconnects. Here it is given the host's, so the only things that end a
 * PTY are the process exiting, an explicit kill, or the daemon itself going
 * away. `spawn` below has no Scope in its signature at all, which makes the
 * wrong thing impossible to write rather than merely discouraged.
 */

import { Context, Effect, Layer, Scope } from "effect";
import { AttachHub } from "./AttachHub.ts";
import type { AttachFrame } from "./AttachProtocol.ts";
import { startAttachServer, type AttachServerError } from "./AttachServer.ts";
import { PtySupervisor } from "./PtySupervisor.ts";
import type { ManagedPty, PtyError, PtySpec } from "./PtyRegistry.ts";

export interface AttachHostOptions {
  /** Unix socket path for the attach stream (SessionPaths.attach). */
  readonly path: string;
  readonly idleTimeoutSeconds?: number;
  /** Veto and record an attachment; failing rejects the client's hello. */
  readonly onAttach?: (client: string) => Effect.Effect<void, unknown>;
  /** An accepted client went away — EOF, error, or idle timeout. */
  readonly onDetach?: (client: string) => Effect.Effect<void, unknown>;
}

export interface AttachHostService {
  /**
   * Start an agent owned by the daemon, not by whoever asked for it.
   *
   * No Scope parameter: the host's scope is already bound in. A caller cannot
   * accidentally tie an agent's life to a request, a connection, or a client.
   */
  readonly spawn: (spec: PtySpec) => Effect.Effect<ManagedPty, PtyError>;
  /** Stop one agent. Its exit frame reaches clients the usual way, through the
   *  supervisor's pump, so a kill and a natural exit look identical to them. */
  readonly kill: (id: string) => Effect.Effect<void, PtyError>;
  /** The agent ids currently running, for a client deciding what to adopt. */
  readonly live: Effect.Effect<readonly string[]>;
  /** Send a frame to every attached client. */
  readonly publish: (frame: AttachFrame) => Effect.Effect<void>;
}

export class AttachHost extends Context.Tag("AttachHost")<AttachHost, AttachHostService>() {}

const make = (
  options: AttachHostOptions,
): Effect.Effect<AttachHostService, AttachServerError, Scope.Scope | AttachHub | PtySupervisor> =>
  Effect.gen(function* () {
    const hub = yield* AttachHub;
    const supervisor = yield* PtySupervisor;
    const host = yield* Effect.scope;

    yield* startAttachServer({
      path: options.path,
      idleTimeoutSeconds: options.idleTimeoutSeconds,
      onAttach: options.onAttach,
      onDetach: options.onDetach,
      // An input or resize naming an agent that is already gone is a benign
      // race — the client had a keystroke in flight when the process exited —
      // not a protocol violation. Logging it keeps the attachment alive;
      // failing here would tear down the socket and every other agent with it.
      onFrame: (_client, frame) =>
        supervisor
          .handle(frame)
          .pipe(
            Effect.catchTag("PtyError", (error) =>
              Effect.logDebug(`attach frame ignored: ${error.operation}: ${error.message}`),
            ),
          ),
    });

    return {
      spawn: (spec) => Scope.extend(supervisor.spawn(spec), host),
      kill: supervisor.kill,
      live: supervisor.live,
      publish: hub.publish,
    };
  });

/**
 * The whole data plane as one layer.
 *
 * AttachHub is provided once at the bottom so the supervisor publishing PTY
 * output and the server subscribing clients to it are talking to the same hub —
 * layer memoization is doing load-bearing work here, not just saving an
 * allocation.
 */
export const layerAttachHost = (
  options: AttachHostOptions,
): Layer.Layer<AttachHost, AttachServerError> =>
  Layer.scoped(AttachHost, make(options)).pipe(
    Layer.provide(PtySupervisor.Live),
    Layer.provide(AttachHub.Default),
  );
