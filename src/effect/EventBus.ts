import { Effect, PubSub, Schema as S, Scope, Stream } from "effect";
import { AgentFrame } from "./AttachProtocol.ts";

const PaneOpened = S.TaggedStruct("pane.opened", {
  pane: S.String,
  session: S.String,
});
const PaneExited = S.TaggedStruct("pane.exited", {
  session: S.String,
  code: S.NullOr(S.Int),
});
const WindowChanged = S.TaggedStruct("window.changed", {
  space: S.String,
  window: S.Int,
  change: S.Literal("created", "renamed", "closed"),
});
const SpaceChanged = S.TaggedStruct("space.changed", {
  space: S.String,
  change: S.Literal("created", "renamed", "closed"),
});
const ClientChanged = S.TaggedStruct("client.changed", {
  client: S.String,
  change: S.Literal("attached", "detached"),
});
const AgentStateChanged = S.TaggedStruct("agent.state", {
  session: S.String,
  state: S.Literal("idle", "working", "blocked", "failed", "detached", "done"),
});
const AgentFrameEvent = S.TaggedStruct("agent.frame", {
  session: S.String,
  frame: AgentFrame,
});
const Notification = S.TaggedStruct("notification", {
  session: S.String,
  title: S.String,
  body: S.String,
});
const EventsReady = S.TaggedStruct("events.ready", {});
const CredentialChanged = S.TaggedStruct("credential.changed", { integration: S.String });
const ModelsRefreshed = S.TaggedStruct("models.refreshed", {});

/** Events emitted by the daemon, rather than observations made by a renderer. */
const EventPayload = S.Union(
  PaneOpened,
  PaneExited,
  WindowChanged,
  SpaceChanged,
  ClientChanged,
  AgentStateChanged,
  AgentFrameEvent,
  Notification,
  EventsReady,
  CredentialChanged,
  ModelsRefreshed,
);
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
