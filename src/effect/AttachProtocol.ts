import { Schema as S } from "effect";

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
 * Semantic events emitted by a native agent session. `sequence` orders events
 * within a session; the IDs make turns, tool calls, and approval requests
 * addressable when a client reconnects or renders them asynchronously.
 * Payloads remain provider-neutral JSON values rather than rendered terminal
 * content or transport-specific handles.
 */
const TurnStart = S.TaggedStruct("turn.start", {
  session: S.String,
  sequence: S.NonNegativeInt,
  turn: S.String,
  prompt: S.String,
});

const TextDelta = S.TaggedStruct("text.delta", {
  session: S.String,
  sequence: S.NonNegativeInt,
  turn: S.String,
  text: S.String,
});

const ToolStart = S.TaggedStruct("tool.start", {
  session: S.String,
  sequence: S.NonNegativeInt,
  turn: S.String,
  call: S.String,
  tool: S.String,
  input: S.Unknown,
});

const ToolResult = S.TaggedStruct("tool.result", {
  session: S.String,
  sequence: S.NonNegativeInt,
  turn: S.String,
  call: S.String,
  output: S.Unknown,
  isError: S.Boolean,
});

const PermissionRequest = S.TaggedStruct("permission.request", {
  session: S.String,
  sequence: S.NonNegativeInt,
  turn: S.String,
  request: S.String,
  tool: S.String,
  description: S.String,
  input: S.Unknown,
});

const PermissionResponse = S.TaggedStruct("permission.response", {
  session: S.String,
  sequence: S.NonNegativeInt,
  turn: S.String,
  request: S.String,
  approved: S.Boolean,
  reason: S.optional(S.String),
});

const AgentStatus = S.TaggedStruct("agent.status", {
  session: S.String,
  sequence: S.NonNegativeInt,
  state: S.Literal("idle", "working", "blocked", "failed", "done"),
});

const TurnEnd = S.TaggedStruct("turn.end", {
  session: S.String,
  sequence: S.NonNegativeInt,
  turn: S.String,
  outcome: S.Literal("completed", "interrupted", "failed"),
});

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

export const AttachFrame = S.Union(
  Hello,
  Output,
  Input,
  Resize,
  Sync,
  Exit,
  Foreground,
  Workspace,
  TurnStart,
  TextDelta,
  ToolStart,
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
export const AgentFrame = S.Union(
  TurnStart,
  TextDelta,
  ToolStart,
  ToolResult,
  PermissionRequest,
  PermissionResponse,
  AgentStatus,
  TurnEnd,
);
export type AgentFrame = S.Schema.Type<typeof AgentFrame>;

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
