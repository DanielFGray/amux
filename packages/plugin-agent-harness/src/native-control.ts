/**
 * The native harness's private component-control protocol. Core transports
 * this as `session.message`; it never needs to understand these verbs.
 *
 * Shared by the daemon half (firstMessage / action payloads) and the worker
 * (decode of inbound messages) — one Schema, no duplicate.
 */
import { Schema as S } from "effect";
import { PermissionDecisionSchema } from "@danielfgray/amux/permission.ts";

export const NativeControl = S.Union([
  S.TaggedStruct("agent.prompt", {
    text: S.String,
    id: S.optional(S.String),
    delivery: S.optional(S.Literals(["steer", "queue"])),
    resume: S.optional(S.Boolean),
    replace: S.optional(S.String),
  }),
  S.TaggedStruct("agent.interrupt", { reason: S.optional(S.String) }),
  S.TaggedStruct("agent.permission", {
    request: S.String,
    decision: PermissionDecisionSchema,
    feedback: S.optional(S.String),
  }),
  S.TaggedStruct("agent.compact", {
    instructions: S.optional(S.String),
  }),
]);
export type NativeControl = typeof NativeControl.Type;
/** Core carries the payload as {@link OwnerJsonText} (JSON text); decode once. */
export const decodeNativeControl = S.decodeUnknownOption(S.fromJsonString(NativeControl));
