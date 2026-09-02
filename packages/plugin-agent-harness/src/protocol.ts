import { Schema as S } from "effect";
import { JsonValueSchema } from "@danielfgray/amux/protocol";
import type { AgentDelta, AgentEvent, JsonValue } from "@danielfgray/amux/protocol";
import { PermissionDecisionSchema, PermissionRuleSchema } from "@danielfgray/amux/permission.ts";

/**
 * The turn loop's vocabulary, owned here rather than by core.
 *
 * Core carries a component's durable events as opaque JSON inside
 * `agent.message` and its live fragments inside `agent.delta`; it orders and
 * replays them without reading either. Everything below is what this harness
 * puts in those envelopes, so a different harness — one with no turns, or no
 * tools — is free to put something else there and still get a log.
 *
 * No member repeats `session`. The envelope already names it, and a copy
 * inside could disagree with the log it was written to.
 */
const TurnStart = S.TaggedStruct("turn.start", {
  turn: S.String,
  prompt: S.String,
});

/** A durably admitted prompt that has not yet been promoted to provider input. */
const TurnQueued = S.TaggedStruct("turn.queued", {
  turn: S.String,
  prompt: S.String,
  delivery: S.Literals(["steer", "queue"]),
});

// Reasoning is an event, not a live-only delta: the pane rebuilds its blocks by
// folding the durable log, so thinking that was never appended vanishes on the
// next remount.
const ReasoningDelta = S.TaggedStruct("reasoning.delta", {
  turn: S.String,
  text: S.String,
});

const ToolStart = S.TaggedStruct("tool.start", {
  turn: S.String,
  call: S.String,
  tool: S.String,
  input: JsonValueSchema,
});

const ToolResult = S.TaggedStruct("tool.result", {
  turn: S.String,
  call: S.String,
  output: JsonValueSchema,
  isError: S.Boolean,
});

const PermissionRequest = S.TaggedStruct("permission.request", {
  turn: S.String,
  request: S.String,
  tool: S.String,
  action: S.String,
  resources: S.Array(S.String),
  save: S.Array(PermissionRuleSchema),
  input: JsonValueSchema,
});

const PermissionResponse = S.TaggedStruct("permission.response", {
  request: S.String,
  decision: PermissionDecisionSchema,
  feedback: S.optional(S.String),
});

/** A provider-level failure the harness saw. Distinct from core's
 *  `session.error`, which is the worker process failing underneath it. */
const AgentError = S.TaggedStruct("agent.error", {
  message: S.String,
});

const TurnEnd = S.TaggedStruct("turn.end", {
  turn: S.String,
  outcome: S.Literals(["completed", "interrupted", "failed"]),
  // The final text makes a completed turn reconstructible after live deltas expire.
  text: S.optional(S.String),
  // Why a failed turn failed. Without it the pane can only say that something
  // went wrong, which leaves a rejected request or a bad credential looking
  // exactly like a model that had nothing to say.
  error: S.optional(S.String),
});

export const HarnessEvent = S.Union([
  TurnQueued,
  TurnStart,
  ReasoningDelta,
  ToolStart,
  ToolResult,
  PermissionRequest,
  PermissionResponse,
  AgentError,
  TurnEnd,
]);
export type HarnessEvent = S.Schema.Type<typeof HarnessEvent>;

const TextDelta = S.TaggedStruct("text.delta", {
  turn: S.String,
  text: S.String,
});

/**
 * A provider begins streaming a tool argument as incremental JSON fragments.
 * `tool.params-start` arrives before any deltas; the `tool.start` event with
 * the parsed input follows the last delta. Every partial-tool fragment shares
 * the call id so a transcript can append deltas into a block the start event
 * created.
 */
const ToolParamsStart = S.TaggedStruct("tool.params-start", {
  turn: S.String,
  call: S.String,
  tool: S.String,
});

/**
 * A single incremental JSON fragment of a streaming tool argument.
 * Concatenating deltas produces the JSON value that will be in the eventual
 * `tool.start` event's `input` field.
 */
const ToolParamsDelta = S.TaggedStruct("tool.params-delta", {
  turn: S.String,
  call: S.String,
  delta: S.String,
});

/**
 * The last partial-tool fragment for this call — no further deltas arrive.
 * The provider has finished streaming the argument; the next tool event for
 * the same call id is `tool.start` with the parsed `input`.
 */
const ToolParamsEnd = S.TaggedStruct("tool.params-end", {
  turn: S.String,
  call: S.String,
});

export const HarnessDelta = S.Union([TextDelta, ToolParamsStart, ToolParamsDelta, ToolParamsEnd]);
export type HarnessDelta = S.Schema.Type<typeof HarnessDelta>;

/** A committed harness event, paired with the order core gave it. */
export type SequencedHarnessEvent = HarnessEvent & { readonly sequence: number };

const encodeEvent = S.encodeSync(HarnessEvent);
const decodeEvent = S.decodeUnknownSync(HarnessEvent);
const encodeDelta = S.encodeSync(HarnessDelta);
const decodeDelta = S.decodeUnknownSync(HarnessDelta);

/** Wrap one harness event as the payload core will commit and sequence. */
export const emit = (session: string, event: HarnessEvent) =>
  ({
    _tag: "agent.message",
    session,
    event: encodeEvent(event) as JsonValue,
  }) as const;

/** Wrap one live fragment. It is delivered as sent and never enters the log. */
export const delta = (session: string, fragment: HarnessDelta) =>
  ({
    _tag: "agent.delta",
    session,
    delta: encodeDelta(fragment) as JsonValue,
  }) as const;

/**
 * Read a harness event back out of a committed log entry.
 *
 * `undefined` for anything this harness did not write — a `topic`, a
 * `session.error`, or an `agent.message` another component put in the same
 * log. A reader folds the log, so it must be able to skip what is not its own
 * rather than fail on it.
 */
export function readEvent(frame: AgentEvent): SequencedHarnessEvent | undefined {
  if (frame._tag !== "agent.message") return undefined;
  try {
    return { ...decodeEvent(frame.event), sequence: frame.sequence };
  } catch {
    return undefined;
  }
}

/** Read a live fragment back out of an `agent.delta` frame. */
export function readDelta(frame: AgentDelta): HarnessDelta | undefined {
  try {
    return decodeDelta(frame.delta);
  } catch {
    return undefined;
  }
}
