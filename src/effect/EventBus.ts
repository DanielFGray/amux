import { Effect, PubSub, Schema as S, Scope, Stream } from "effect";

const AgentStateChanged = S.TaggedStruct("agent.state", {
  session: S.String,
  state: S.Literal("idle", "working", "blocked", "failed", "detached", "done"),
});
const EventsReady = S.TaggedStruct("events.ready", {});
const CredentialChanged = S.TaggedStruct("credential.changed", { integration: S.String });
const ModelsRefreshed = S.TaggedStruct("models.refreshed", {});

/**
 * Facts a client cannot learn from anything it already receives.
 *
 * Workspace changes reach clients as a whole snapshot and agent output reaches
 * them as a replayable transcript, both over the attach hub; re-announcing
 * either one here would be the same fact on two channels. What is left is
 * out-of-band: agent liveness, and configuration that changes underneath a
 * client that never asked for it.
 */
const EventPayload = S.Union(AgentStateChanged, EventsReady, CredentialChanged, ModelsRefreshed);
export const DaemonEvent = S.Struct({
  sequence: S.NonNegativeInt,
  event: EventPayload,
});
export type DaemonEvent = S.Schema.Type<typeof DaemonEvent>;
export type DaemonEventPayload = S.Schema.Type<typeof EventPayload>;

const EVENT_CAPACITY = 256;

export interface EventBusService {
  readonly publish: (event: DaemonEventPayload) => Effect.Effect<void>;
  readonly subscribe: () => Effect.Effect<Stream.Stream<DaemonEvent>, never, Scope.Scope>;
  readonly shutdown: Effect.Effect<void>;
}

/** A slow observer must not suspend PTY publication or the mutation queue. */
export class EventBus extends Effect.Service<EventBus>()("EventBus", {
  effect: Effect.gen(function* () {
    const pubsub = yield* PubSub.sliding<DaemonEvent>(EVENT_CAPACITY);
    let sequence = 1;
    return {
      publish: (event) =>
        PubSub.publish(pubsub, { sequence: sequence++, event }).pipe(Effect.asVoid),
      subscribe: () =>
        PubSub.subscribe(pubsub).pipe(Effect.map((queue) => Stream.fromQueue(queue))),
      shutdown: PubSub.shutdown(pubsub),
    } satisfies EventBusService;
  }),
}) {}
