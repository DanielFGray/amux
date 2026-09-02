import { Schema as S, SchemaAST as AST } from "effect";
import { PermissionDecisionSchema } from "../permission.ts";
import { errorMessage } from "../error-message.ts";

export const SESSION_STATE_TOPIC = "session.state";

/** JSON values are the only opaque values that may cross a persisted or wire boundary. */
export const JsonValueSchema: S.Codec<JsonValue> = S.suspend(() =>
  S.Union([
    S.Null,
    S.String,
    S.Boolean,
    S.Finite,
    S.Array(JsonValueSchema),
    S.Record(S.String, JsonValueSchema),
  ]),
) as S.Codec<JsonValue>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * The framed wire protocol between a client and the attach daemon.
 *
 * Vocabulary (survives from the rename off `agent`):
 * - session: a daemon-owned backend instance — a supervised PTY today, an LLM
 *   agent session later. Every frame field named `session` identifies one.
 * - pane: a view of a session in a UI layout.
 * - agent: an LLM coding agent (the future backend kind), never the supervised
 *   PTY. The old name for the PTY-scoped meaning collided with this.
 */
const Hello = S.TaggedStruct("hello", {
  client: S.String,
});

const Output = S.TaggedStruct("output", {
  session: S.String,
  data: S.Uint8ArrayFromBase64,
});

const Input = S.TaggedStruct("input", {
  session: S.String,
  data: S.Uint8ArrayFromBase64,
});

const Resize = S.TaggedStruct("resize", {
  session: S.String,
  cols: S.Int,
  rows: S.Int,
});

/**
 * Ask the daemon to replay a session's current screen to this client.
 *
 * Sent once when a client adopts a session the daemon is already running. The
 * daemon answers with an `output` frame carrying the serialized screen (modes
 * and content) ahead of the session's live bytes, so a reattaching client's
 * pane is not blank until the program next redraws. Only adopted sessions need
 * it: an attached client sees a newly created session's bytes from the first one.
 */
const Sync = S.TaggedStruct("sync", {
  session: S.String,
  after: S.optional(S.Int.check(S.isGreaterThanOrEqualTo(0))),
});

/**
 * The daemon's answer to "what is in the foreground of this session's tty".
 *
 * The daemon owns the PTY, so only it can ask the tty which process group is
 * in the foreground (tcgetpgrp) and what its session id is (tcgetsid); a
 * client reading the same tty gets -1. Sent whenever either value changes —
 * and once when the session starts, so attached clients observing a new or
 * adopted session learn the current state without asking. The client keeps
 * reading /proc for the actual cmdline: pids are a global namespace, the
 * foreground pgid is not. The daemon also reads the process's argv so plugins
 * never need process-table access in the client.
 */
const Foreground = S.TaggedStruct("foreground", {
  session: S.String,
  /** Foreground process group of the controlling tty, or -1. Equal to the
   *  session id while a shell sits at a prompt. */
  pgid: S.Int,
  /** Session id = the session leader's pid, or -1 when it is not knowable. */
  sid: S.Int,
  /** Full argv of the foreground process, read by the PTY-owning daemon. Empty
   *  at a shell prompt or when process inspection is unavailable. */
  argv: S.Array(S.String),
});

/**
 * An authoritative workspace generation. Model state is a separate tagged
 * concern on the shared transport; terminal byte frames retain their own
 * session ordering and routing.
 */
const Workspace = S.TaggedStruct("workspace", {
  revision: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  state: S.String,
});

const Exit = S.TaggedStruct("exit", {
  session: S.String,
  code: S.NullOr(S.Int),
});

/**
 * A durable value published under a name whose meaning belongs to the named
 * subscriber, not core.
 */
const topicFields = {
  session: S.String,
  topic: S.String,
  payload: JsonValueSchema,
};
const TopicPayload = S.TaggedStruct("topic", topicFields);
export const Topic = S.TaggedStruct("topic", {
  ...topicFields,
  sequence: S.Int.check(S.isGreaterThanOrEqualTo(0)),
});
export type Topic = S.Schema.Type<typeof Topic>;

/**
 * One durable event in a session's log, whose contents core does not read.
 *
 * A turn beginning, a tool call, a permission request — that is a turn loop's
 * vocabulary, and a multiplexor that spelled it out here would be asserting
 * that every component session has turns and tools. What core actually needs
 * is far less: `session` says which log, `sequence` orders it, and `event` is
 * carried verbatim. `AgentLog` bears this out — it reads only those two fields
 * and never inspects a payload.
 *
 * The harness owns the schema inside `event` and is the only thing that
 * decodes it. Core stores, orders and replays.
 */
const agentMessageFields = {
  session: S.String,
  event: JsonValueSchema,
};
const AgentMessagePayload = S.TaggedStruct("agent.message", agentMessageFields);
const AgentMessage = S.TaggedStruct("agent.message", {
  ...agentMessageFields,
  sequence: S.Int.check(S.isGreaterThanOrEqualTo(0)),
});

/**
 * A component's worker failed in a way core itself observed.
 *
 * Core spawns and supervises that worker, so its stderr and its death are
 * core's business rather than the harness's — unlike everything inside
 * `agent.message`, which core only carries. Durable, because a worker that
 * died before emitting anything must still leave a trace in the log.
 */
const sessionErrorFields = {
  session: S.String,
  message: S.String,
};
const SessionErrorPayload = S.TaggedStruct("session.error", sessionErrorFields);
const SessionError = S.TaggedStruct("session.error", {
  ...sessionErrorFields,
  sequence: S.Int.check(S.isGreaterThanOrEqualTo(0)),
});

/**
 * Everything a component may add to its log, before the daemon commits it.
 *
 * Three envelopes, none of which core reads into: a value published under a
 * name, an opaque durable event, and the one failure core saw for itself.
 */
export const AgentEventPayloadSchema = S.Union([
  TopicPayload,
  AgentMessagePayload,
  SessionErrorPayload,
]);
export const isAgentEventPayload = S.is(AgentEventPayloadSchema);

/**
 * A component asking the daemon to commit one event to its log.
 *
 * The payload is nested rather than sent flat because the committed form
 * carries the same tag plus a `sequence` the daemon alone assigns. Keeping the
 * request in its own frame is what stops a worker from writing that field
 * itself and choosing its own place in the order.
 */
const AgentEmit = S.TaggedStruct("agent.emit", { event: AgentEventPayloadSchema });

/**
 * A live fragment that is never appended to the log.
 *
 * Streamed text and partial tool arguments exist only to keep a pane moving
 * while a durable event is still being assembled; a client that attaches later
 * rebuilds from the log instead. Opaque for the same reason as `agent.message`,
 * and a frame of its own because carrying a sequence would promise a replay
 * that never comes.
 */
export const AgentDelta = S.TaggedStruct("agent.delta", {
  session: S.String,
  delta: JsonValueSchema,
});
export type AgentDelta = S.Schema.Type<typeof AgentDelta>;

/** Private harness control payload. It is carried in `session.message`, not a
 * core attach-frame tag. */
export type PermissionAnswer = {
  readonly request: string;
  readonly decision: S.Schema.Type<typeof PermissionDecisionSchema>;
  readonly feedback?: string;
};

/** Opaque control input for a component session. Core routes the envelope but
 * assigns no meaning to its payload; that protocol belongs to the harness. */
const SessionMessage = S.TaggedStruct("session.message", {
  session: S.String,
  message: JsonValueSchema,
});

const ErrorFrame = S.TaggedStruct("error", {
  message: S.String,
});

const Ping = S.TaggedStruct("ping", {
  nonce: S.String,
});

const Pong = S.TaggedStruct("pong", {
  nonce: S.String,
});

/**
 * Ask an attached client to run a command against its own registry.
 *
 * The daemon runs no plugins (see ARCHITECTURE.md), so a plugin-registered
 * command can only be executed where the plugin loaded: a connected client.
 * `command` is opaque JSON here — the client decodes it against whatever
 * schema the tag's owner (core or plugin) registered.
 */
const CommandRequest = S.TaggedStruct("command.request", {
  id: S.String,
  command: JsonValueSchema,
});

/** The client's answer to a `command.request`, correlated by `id`. */
const CommandResponse = S.TaggedStruct("command.response", {
  id: S.String,
  result: S.optional(JsonValueSchema),
  error: S.optional(S.String),
});

/** A committed log entry: what the daemon publishes after assigning `sequence`. */
export const AgentEvent = S.Union([Topic, AgentMessage, SessionError]);
export type AgentEvent = S.Schema.Type<typeof AgentEvent>;
export type AgentEventPayload = S.Schema.Type<typeof AgentEventPayloadSchema>;
export const isAgentEvent = S.is(AgentEvent);

export const AttachFrame = S.Union([
  Hello,
  Output,
  Input,
  Resize,
  Sync,
  Exit,
  Foreground,
  Workspace,
  AgentEmit,
  Topic,
  AgentMessage,
  SessionError,
  AgentDelta,
  SessionMessage,
  ErrorFrame,
  Ping,
  Pong,
  CommandRequest,
  CommandResponse,
]);
export type AttachFrame = S.Schema.Type<typeof AttachFrame>;
export type AgentEmit = S.Schema.Type<typeof AgentEmit>;

function taggedSchemaTag(ast: AST.AST): string | undefined {
  if (ast._tag !== "Objects") return undefined;
  const tag = ast.propertySignatures.find((property) => property.name === "_tag")?.type;
  return tag && AST.isLiteral(tag) && typeof tag.literal === "string" ? tag.literal : undefined;
}

/** Every wire tag is deliverable unless the attach client explicitly excludes it. */
export const AttachFrameTags = new Set(
  (AST.isUnion(AttachFrame.ast) ? AttachFrame.ast.types : [AttachFrame.ast])
    .map(taggedSchemaTag)
    .filter((tag): tag is string => tag !== undefined),
);

export const AgentFrame = S.Union([AgentEvent, AgentDelta]);
export type AgentFrame = AgentEvent | AgentDelta;

export class AttachProtocolError extends S.TaggedError<AttachProtocolError>()(
  "AttachProtocolError",
  {
    message: S.String,
  },
) {}

/** Accumulates raw socket bytes and emits complete newline-delimited frames. */
export class AttachFrameAccumulator {
  private buffer = new Uint8Array(0);

  get byteLength(): number {
    return this.buffer.byteLength;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.byteLength);
    const frames: Uint8Array[] = [];
    let start = 0;
    for (let index = 0; index < joined.byteLength; index++) {
      if (joined[index] !== 0x0a) continue;
      frames.push(joined.slice(start, index + 1));
      start = index + 1;
    }
    this.buffer = joined.slice(start);
    return frames;
  }
}

/** Encode one frame. Newline is the framing boundary, not part of the payload. */
export function encodeAttachFrame(frame: AttachFrame): string {
  return `${JSON.stringify(S.encodeSync(AttachFrame)(frame))}\n`;
}

export function encodeAttachFrameBytes(frame: AttachFrame): Uint8Array {
  return new TextEncoder().encode(encodeAttachFrame(frame));
}

/**
 * Decode as many complete newline-delimited frames as are available.
 * Incomplete trailing data is returned for the next socket read.
 */
export function decodeAttachFrames(input: string) {
  const lines = input.split("\n");
  const rest = lines.pop() ?? "";
  const frames: AttachFrame[] = [];

  for (const line of lines) {
    if (!line) continue;
    try {
      frames.push(S.decodeSync(S.fromJsonString(AttachFrame))(line));
    } catch (error) {
      throw new AttachProtocolError({ message: errorMessage(error) });
    }
  }

  return { frames, rest };
}
