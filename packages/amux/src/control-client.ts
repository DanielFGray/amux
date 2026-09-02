/**
 * The client half of the control plane.
 *
 * The protocol layer must be built into the *caller's* scope, not into an
 * ephemeral one: `Effect.provide(layer)` would close the socket the moment
 * `RpcClient.make` returned, and every later call would fail on a dead
 * connection. Long-lived callers (`SessionClient`) build it once for their
 * lifetime; one-shot callers (`amux status`, liveness probes) use
 * {@link controlCall}, which opens and closes a connection per request.
 */
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { Effect, Layer, Schema as S, Scope, Stream } from "effect";
import { ControlError, ControlRpcs, ControlSerialization } from "./control.ts";
import type { DaemonEvent, DaemonEventPayload } from "./effect/EventBus.ts";
import type { AgentEvent } from "./effect/AttachProtocol.ts";
import { sessionPaths } from "./session.ts";
import { errorMessage } from "./error-message.ts";

/**
 * Every procedure of the group. Each call fails with the daemon's typed
 * ControlError or with RpcClientError when the connection itself breaks.
 */
export type ControlClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ControlRpcs>, RpcClientError>;

/** All a control connection needs is the env that resolves the session socket. */
/**
 * Open a control connection to a session's Unix socket, alive for the
 * enclosing scope.
 */
export const connectControl = (
  id: string,
): Effect.Effect<ControlClient, ControlError, Scope.Scope> =>
  Effect.gen(function* () {
    const paths = yield* sessionPaths(id);
    return yield* connectControlPath(paths.socket);
  }).pipe(Effect.mapError(toControlError));

/** Connect directly when a supervised child has been given the socket path. */
export const connectControlPath = (
  socket: string,
): Effect.Effect<ControlClient, ControlError, Scope.Scope> =>
  Effect.gen(function* () {
    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(NodeSocket.layerNet({ path: socket })),
      Layer.provide(ControlSerialization),
    );
    const context = yield* Layer.build(protocol);
    return yield* RpcClient.make(ControlRpcs, { disableTracing: true }).pipe(
      Effect.provide(context),
    );
  }).pipe(Effect.mapError(toControlError));

/** One request against a live daemon, on a connection that dies with it. */
export const controlCall = <A, E>(
  id: string,
  use: (client: ControlClient) => Effect.Effect<A, E>,
): Effect.Effect<A, ControlError | E> => Effect.scoped(Effect.flatMap(connectControl(id), use));

export const controlCallPath = <A, E>(
  socket: string,
  use: (client: ControlClient) => Effect.Effect<A, E>,
): Effect.Effect<A, ControlError | E> =>
  Effect.scoped(Effect.flatMap(connectControlPath(socket), use));

/**
 * Subscribe to daemon events for the enclosing control connection scope. The
 * stream owns the RPC request, so callers must keep the returned scope alive
 * while consuming it.
 */
export const controlEvents = (
  id: string,
): Effect.Effect<Stream.Stream<DaemonEventPayload, RpcClientError>, ControlError, Scope.Scope> =>
  Effect.map(controlEventFrames(id), (events) => events.pipe(Stream.map(({ event }) => event)));

/** Subscribe while retaining sequence numbers for gap detection. */
export const controlEventFrames = (
  id: string,
): Effect.Effect<Stream.Stream<DaemonEvent, RpcClientError>, ControlError, Scope.Scope> =>
  Effect.map(connectControl(id), (control) => control.Events().pipe(Stream.drop(1)));

/** Keep only one family of daemon events while preserving stream lifetime. */
export const filterControlEvents = <T extends DaemonEventPayload["_tag"]>(
  events: Stream.Stream<DaemonEventPayload, RpcClientError>,
  tag: T,
): Stream.Stream<Extract<DaemonEventPayload, { readonly _tag: T }>, RpcClientError> =>
  events.pipe(
    Stream.filter(
      (event): event is Extract<DaemonEventPayload, { readonly _tag: T }> => event._tag === tag,
    ),
  );

export const agentCursor = (control: ControlClient, session: string) =>
  control.AgentCursor({ session });

export const agentWatch = (
  control: ControlClient,
  session: string,
  after?: number,
): Stream.Stream<AgentEvent, RpcClientError> =>
  control.AgentWatch(after === undefined || after < 0 ? { session } : { session, after });

/**
 * Why a wait on an agent ended without the turn it was waiting for.
 *
 * Both names are machine-facing: a caller matches on the token, so they are
 * defined once here and every union, guard, and rendering derives from this
 * literal rather than restating the members.
 *
 * `agent_prompt_stalled` is the five-second guard — a prompt submitted from a
 * settled state produced no lifecycle change at all, which means the agent
 * never took the work rather than that it is slow. `agent_wait_timeout` is the
 * caller's own deadline elapsing while the turn was genuinely in progress.
 */
export const AgentWaitReason = S.Literals(["agent_prompt_stalled", "agent_wait_timeout"]);
export type AgentWaitReason = typeof AgentWaitReason.Type;

export class AgentWaitError extends S.TaggedError<AgentWaitError>()("AgentWaitError", {
  reason: AgentWaitReason,
}) {
  /** The token alone: it is what a caller greps for, and what the CLI printed
   *  back when this was an untagged Error carrying the same string. */
  override get message(): string {
    return this.reason;
  }
}

/** Return the number of events missed between two retained bus frames. */
export const eventGap = (previous: DaemonEvent, current: DaemonEvent): number =>
  Math.max(0, current.sequence - previous.sequence - 1);

/** Collapse transport and protocol failures onto the control plane's one error. */
export const toControlError = (error: ControlError | RpcClientError | Error): ControlError =>
  S.is(ControlError)(error)
    ? error
    : new ControlError({
        message: errorMessage(error),
      });
