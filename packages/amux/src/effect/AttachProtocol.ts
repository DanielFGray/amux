import { Schema as S, SchemaAST as AST } from "effect";
import { PermissionDecisionSchema, PermissionRuleSchema } from "../permission.ts";

export const SESSION_STATE_TOPIC = "session.state";

/** JSON values are the only opaque values that may cross a persisted or wire boundary. */
export const JsonValueSchema: S.Codec<JsonValue> = S.suspend(() =>
  S.Union([
    S.Null,
    S.String,
    S.Boolean,
    S.Number.pipe(S.check(S.isFinite())),
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
  after: S.optional(S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0))),
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
  revision: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  state: S.String,
});

const Exit = S.TaggedStruct("exit", {
  session: S.String,
  code: S.NullOr(S.Int),
});

/**
 * Durable semantic events emitted by a native agent session. `sequence` is
 * assigned by the daemon when the event is committed to the session log.
 * Payloads remain provider-neutral JSON values rather than rendered terminal
 * content or transport-specific handles.
 */
const turnStartFields = {
  session: S.String,
  turn: S.String,
  prompt: S.String,
};
const TurnStartPayload = S.TaggedStruct("turn.start", turnStartFields);
const TurnStart = S.TaggedStruct("turn.start", {
  ...turnStartFields,
  sequence: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});

/** A durably admitted prompt that has not yet been promoted to provider input. */
const turnQueuedFields = {
  session: S.String,
  turn: S.String,
  prompt: S.String,
  delivery: S.Literals(["steer", "queue"]),
};
const TurnQueuedPayload = S.TaggedStruct("turn.queued", turnQueuedFields);
const TurnQueued = S.TaggedStruct("turn.queued", {
  ...turnQueuedFields,
  sequence: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});

const TextDelta = S.TaggedStruct("text.delta", {
  session: S.String,
  turn: S.String,
  text: S.String,
});

// Reasoning is an event, not a live-only delta: the pane rebuilds its blocks by
// folding the durable log, so thinking that was never appended vanishes on the
// next remount. It therefore carries a sequence like every other event.
const reasoningDeltaFields = {
  session: S.String,
  turn: S.String,
  text: S.String,
};
const ReasoningDeltaPayload = S.TaggedStruct("reasoning.delta", reasoningDeltaFields);
const ReasoningDelta = S.TaggedStruct("reasoning.delta", {
  ...reasoningDeltaFields,
  sequence: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});

const toolStartFields = {
  session: S.String,
  turn: S.String,
  call: S.String,
  tool: S.String,
  input: JsonValueSchema,
};
const ToolStartPayload = S.TaggedStruct("tool.start", toolStartFields);
const ToolStart = S.TaggedStruct("tool.start", {
  ...toolStartFields,
  sequence: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});

/**
 * A provider begins streaming a tool argument as incremental JSON fragments.
 * `tool.params-start` arrives before any deltas; the `tool.start` frame with
 * the parsed input follows the last delta. Every partial-tool frame shares
 * the call id so a transcript can append deltas into a block the start frame
 * created.
 */
const ToolParamsStart = S.TaggedStruct("tool.params-start", {
  session: S.String,
  turn: S.String,
  call: S.String,
  tool: S.String,
});

/**
 * A single incremental JSON fragment of a streaming tool argument.
 * Concatenating deltas produces the JSON value that will be in the eventual
 * `tool.start` frame's `input` field.
 */
const ToolParamsDelta = S.TaggedStruct("tool.params-delta", {
  session: S.String,
  turn: S.String,
  call: S.String,
  delta: S.String,
});

/**
 * The last partial-tool frame for this call — no further deltas arrive.
 * The provider has finished streaming the argument; the next tool event
 * for the same call id is `tool.start` with the parsed `input`.
 */
const ToolParamsEnd = S.TaggedStruct("tool.params-end", {
  session: S.String,
  turn: S.String,
  call: S.String,
});

const toolResultFields = {
  session: S.String,
  turn: S.String,
  call: S.String,
  output: JsonValueSchema,
  isError: S.Boolean,
};
const ToolResultPayload = S.TaggedStruct("tool.result", toolResultFields);
const ToolResult = S.TaggedStruct("tool.result", {
  ...toolResultFields,
  sequence: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});

const permissionRequestFields = {
  session: S.String,
  turn: S.String,
  request: S.String,
  tool: S.String,
  action: S.String,
  resources: S.Array(S.String),
  save: S.Array(PermissionRuleSchema),
  input: JsonValueSchema,
};
const PermissionRequestPayload = S.TaggedStruct("permission.request", permissionRequestFields);
const PermissionRequest = S.TaggedStruct("permission.request", {
  ...permissionRequestFields,
  sequence: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});
const permissionResponseFields = {
  session: S.String,
  request: S.String,
  decision: PermissionDecisionSchema,
  feedback: S.optional(S.String),
};
const PermissionResponsePayload = S.TaggedStruct("permission.response", permissionResponseFields);
const PermissionResponse = S.TaggedStruct("permission.response", {
  ...permissionResponseFields,
  sequence: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});

/** A durable value whose meaning belongs to the named subscriber, not core. */
const topicFields = {
  session: S.String,
  topic: S.String,
  payload: JsonValueSchema,
};
const TopicPayload = S.TaggedStruct("topic", topicFields);
export const Topic = S.TaggedStruct("topic", {
  ...topicFields,
  sequence: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});
export type Topic = S.Schema.Type<typeof Topic>;

const AgentErrorFields = {
  session: S.String,
  message: S.String,
};
const AgentErrorPayload = S.TaggedStruct("agent.error", AgentErrorFields);
const AgentError = S.TaggedStruct("agent.error", {
  ...AgentErrorFields,
  sequence: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});

const turnEndFields = {
  session: S.String,
  turn: S.String,
  outcome: S.Literals(["completed", "interrupted", "failed"]),
  // The final text makes a completed turn reconstructible after live deltas expire.
  text: S.optional(S.String),
  // Why a failed turn failed. Without it the pane can only say that something
  // went wrong, which leaves a rejected request or a bad credential looking
  // exactly like a model that had nothing to say.
  error: S.optional(S.String),
};
const TurnEndPayload = S.TaggedStruct("turn.end", turnEndFields);
const TurnEnd = S.TaggedStruct("turn.end", {
  ...turnEndFields,
  sequence: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});

export const AgentEventPayloadSchema = S.Union([
  TurnQueuedPayload,
  TurnStartPayload,
  ReasoningDeltaPayload,
  ToolStartPayload,
  ToolResultPayload,
  PermissionRequestPayload,
  PermissionResponsePayload,
  TopicPayload,
  AgentErrorPayload,
  TurnEndPayload,
]);
const AgentEventInputFrame = S.TaggedStruct("agent.event", { event: AgentEventPayloadSchema });

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

export const AgentEvent = S.Union([
  TurnQueued,
  TurnStart,
  ReasoningDelta,
  ToolStart,
  ToolResult,
  PermissionRequest,
  PermissionResponse,
  Topic,
  AgentError,
  TurnEnd,
]);
export type AgentEvent = S.Schema.Type<typeof AgentEvent>;
export type AgentEventPayload = AgentEvent extends infer Event
  ? Event extends { readonly sequence: number }
    ? Omit<Event, "sequence">
    : never
  : never;
export const isAgentEventPayload = S.is(AgentEventPayloadSchema);

export const AgentDelta = S.Union([TextDelta, ToolParamsStart, ToolParamsDelta, ToolParamsEnd]);
export type AgentDelta = S.Schema.Type<typeof AgentDelta>;

export const AttachFrame = S.Union([
  Hello,
  Output,
  Input,
  Resize,
  Sync,
  Exit,
  Foreground,
  Workspace,
  AgentEventInputFrame,
  TurnQueued,
  TurnStart,
  TextDelta,
  ReasoningDelta,
  ToolStart,
  ToolParamsStart,
  ToolParamsDelta,
  ToolParamsEnd,
  ToolResult,
  PermissionRequest,
  PermissionResponse,
  Topic,
  AgentError,
  TurnEnd,
  SessionMessage,
  ErrorFrame,
  Ping,
  Pong,
  CommandRequest,
  CommandResponse,
]);
export type AttachFrame = S.Schema.Type<typeof AttachFrame>;
export type AgentEventInputFrame = S.Schema.Type<typeof AgentEventInputFrame>;

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
export const isAgentEvent = S.is(AgentEvent);

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
      frames.push(S.decodeUnknownSync(S.fromJsonString(AttachFrame))(line));
    } catch (error) {
      throw new AttachProtocolError({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { frames, rest };
}
