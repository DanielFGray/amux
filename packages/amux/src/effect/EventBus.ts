import { Context, Effect, Layer, PubSub, Schema as S, Scope, Stream } from "effect";

/** A daemon-owned session's process state. The state vocabulary is supplied by
 * the process integration, not by the core event transport. */
const SessionStateChanged = S.TaggedStruct("session.state", {
  session: S.String,
  state: S.String,
});
const Notification = S.TaggedStruct("notification", {
  session: S.String,
  title: S.String,
  body: S.String,
});
const EventsReady = S.TaggedStruct("events.ready", {});
const CredentialChanged = S.TaggedStruct("credential.changed", { integration: S.String });
/** Somebody edited a plugin's source. Each client runs its own plugins from its
 *  own config, so the daemon only carries the request; the reload is local. */
const PluginsReload = S.TaggedStruct("plugins.reload", { plugin: S.optional(S.String) });
const ModelsRefreshed = S.TaggedStruct("models.refreshed", {});

/**
 * Facts a client cannot learn from anything it already receives.
 *
 * Workspace changes reach clients as a whole snapshot and agent output reaches
 * them as a replayable transcript, both over the attach hub; re-announcing
 * either one here would be the same fact on two channels. What is left is
 * out-of-band: agent liveness, a notification an agent chose to send, and
 * configuration that changes underneath a client that never asked for it.
 */
const EventPayload = S.Union([
  SessionStateChanged,
  Notification,
  EventsReady,
  CredentialChanged,
  ModelsRefreshed,
  PluginsReload,
]);
export const DaemonEvent = S.Struct({
  sequence: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  event: EventPayload,
});
export type DaemonEvent = S.Schema.Type<typeof DaemonEvent>;
export type DaemonEventPayload = S.Schema.Type<typeof EventPayload>;

const EVENT_CAPACITY = 256;

export interface EventBusService {
  readonly publish: (event: DaemonEventPayload) => Effect.Effect<void>;
  readonly subscribe: Effect.Effect<Stream.Stream<DaemonEvent>, never, Scope.Scope>;
  readonly shutdown: Effect.Effect<void>;
}

/** A slow observer must not suspend PTY publication or the mutation queue. */
export class EventBus extends Context.Service<EventBus>()("EventBus", {
  make: Effect.gen(function* () {
    const pubsub = yield* PubSub.sliding<DaemonEvent>(EVENT_CAPACITY);
    let sequence = 1;
    return {
      publish: (event) =>
        PubSub.publish(pubsub, { sequence: sequence++, event }).pipe(Effect.asVoid),
      subscribe: PubSub.subscribe(pubsub).pipe(
        Effect.map((queue) => Stream.fromSubscription(queue)),
      ),
      shutdown: PubSub.shutdown(pubsub),
    } satisfies EventBusService;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
