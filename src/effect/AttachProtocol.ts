import { Schema as S } from "effect";
import { ReportedAgentStateSchema } from "../agent-state.ts";

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
  after: S.optional(S.NonNegativeInt),
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
 * foreground pgid is not.
 */
const Foreground = S.TaggedStruct("foreground", {
  session: S.String,
  /** Foreground process group of the controlling tty, or -1. Equal to the
   *  session id while a shell sits at a prompt. */
  pgid: S.Int,
  /** Session id = the session leader's pid, or -1 when it is not knowable. */
  sid: S.Int,
});

/**
 * An authoritative workspace generation. Model state is a separate tagged
 * concern on the shared transport; terminal byte frames retain their own
 * session ordering and routing.
 */
const Workspace = S.TaggedStruct("workspace", {
  revision: S.NonNegativeInt,
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
const TurnStart = S.TaggedStruct("turn.start", { ...turnStartFields, sequence: S.NonNegativeInt });

const TextDelta = S.TaggedStruct("text.delta", {
  session: S.String,
  turn: S.String,
  text: S.String,
});

const toolStartFields = {
  session: S.String,
  turn: S.String,
  call: S.String,
  tool: S.String,
  input: S.Unknown,
};
const ToolStartPayload = S.TaggedStruct("tool.start", toolStartFields);
const ToolStart = S.TaggedStruct("tool.start", { ...toolStartFields, sequence: S.NonNegativeInt });

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
  output: S.Unknown,
  isError: S.Boolean,
};
const ToolResultPayload = S.TaggedStruct("tool.result", toolResultFields);
const ToolResult = S.TaggedStruct("tool.result", { ...toolResultFields, sequence: S.NonNegativeInt });

const permissionRequestFields = {
  session: S.String,
  turn: S.String,
  request: S.String,
  tool: S.String,
  description: S.String,
  input: S.Unknown,
};
const PermissionRequestPayload = S.TaggedStruct("permission.request", permissionRequestFields);
const PermissionRequest = S.TaggedStruct("permission.request", {
  ...permissionRequestFields,
  sequence: S.NonNegativeInt,
});

const permissionResponseFields = {
  session: S.String,
  turn: S.String,
  request: S.String,
  approved: S.Boolean,
  reason: S.optional(S.String),
};
const PermissionResponsePayload = S.TaggedStruct("permission.response", permissionResponseFields);
const PermissionResponse = S.TaggedStruct("permission.response", {
  ...permissionResponseFields,
  sequence: S.NonNegativeInt,
});

const agentStatusFields = {
  session: S.String,
  state: ReportedAgentStateSchema,
};
const AgentStatusPayload = S.TaggedStruct("agent.status", agentStatusFields);
const AgentStatus = S.TaggedStruct("agent.status", {
  ...agentStatusFields,
  sequence: S.NonNegativeInt,
});

const turnEndFields = {
  session: S.String,
  turn: S.String,
  outcome: S.Literal("completed", "interrupted", "failed"),
  // The final text makes a completed turn reconstructible after live deltas expire.
  text: S.optional(S.String),
  // Why a failed turn failed. Without it the pane can only say that something
  // went wrong, which leaves a rejected request or a bad credential looking
  // exactly like a model that had nothing to say.
  error: S.optional(S.String),
};
const TurnEndPayload = S.TaggedStruct("turn.end", turnEndFields);
const TurnEnd = S.TaggedStruct("turn.end", { ...turnEndFields, sequence: S.NonNegativeInt });

export const AgentEventPayloadSchema = S.Union(
  TurnStartPayload,
  ToolStartPayload,
  ToolResultPayload,
  PermissionRequestPayload,
  PermissionResponsePayload,
  AgentStatusPayload,
  TurnEndPayload,
);
const AgentEventInputFrame = S.TaggedStruct("agent.event", { event: AgentEventPayloadSchema });

const AgentSteer = S.TaggedStruct("agent.steer", {
  session: S.String,
  message: S.String,
});

const AgentInterrupt = S.TaggedStruct("agent.interrupt", {
  session: S.String,
  reason: S.optional(S.String),
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

export const AgentEvent = S.Union(
  TurnStart,
  ToolStart,
  ToolResult,
  PermissionRequest,
  PermissionResponse,
  AgentStatus,
  TurnEnd,
);
export type AgentEvent = S.Schema.Type<typeof AgentEvent>;
export type AgentEventPayload = AgentEvent extends infer Event
  ? Event extends { readonly sequence: number }
    ? Omit<Event, "sequence">
    : never
  : never;
export const isAgentEventPayload = S.is(AgentEventPayloadSchema);

export const AgentDelta = S.Union(TextDelta, ToolParamsStart, ToolParamsDelta, ToolParamsEnd);
export type AgentDelta = S.Schema.Type<typeof AgentDelta>;

export const AttachFrame = S.Union(
  Hello,
  Output,
  Input,
  Resize,
  Sync,
  Exit,
  Foreground,
  Workspace,
  AgentEventInputFrame,
  TurnStart,
  TextDelta,
  ToolStart,
  ToolParamsStart,
  ToolParamsDelta,
  ToolParamsEnd,
  ToolResult,
  PermissionRequest,
  PermissionResponse,
  AgentStatus,
  TurnEnd,
  AgentSteer,
  AgentInterrupt,
  ErrorFrame,
  Ping,
  Pong,
);
export type AttachFrame = S.Schema.Type<typeof AttachFrame>;
export type AgentEventInputFrame = S.Schema.Type<typeof AgentEventInputFrame>;
export const AgentFrame = S.Union(AgentEvent, AgentDelta);
export type AgentFrame = AgentEvent | AgentDelta;
export const isAgentEvent = S.is(AgentEvent);

export class AttachProtocolError extends S.TaggedError<AttachProtocolError>()(
  "AttachProtocolError",
  {
    message: S.String,
  },
) {}

/** Encode one frame. Newline is the framing boundary, not part of the payload. */
export function encodeAttachFrame(frame: AttachFrame): string {
  return `${JSON.stringify(S.encodeSync(AttachFrame)(frame))}\n`;
}

/**
 * Decode as many complete newline-delimited frames as are available.
 * Incomplete trailing data is returned for the next socket read.
 */
export function decodeAttachFrames(input: string): { frames: AttachFrame[]; rest: string } {
  const lines = input.split("\n");
  const rest = lines.pop() ?? "";
  const frames: AttachFrame[] = [];

  for (const line of lines) {
    if (!line) continue;
    try {
      frames.push(S.decodeUnknownSync(AttachFrame)(JSON.parse(line)));
    } catch (error) {
      throw new AttachProtocolError({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { frames, rest };
}
