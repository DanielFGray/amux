/**
 * Agent command field Schemas and typed builders shared by the daemon
 * registration and the client UI. No reduce/run — those stay in daemon.ts.
 */
import { Schema as S } from "effect";
import { encodeRegisteredCommand, ProcessStateSchema } from "@danielfgray/amux";
import { PermissionDecisionSchema } from "@danielfgray/amux/permission.ts";

const sessionTarget = { target: S.String };

export const AgentNewArgs = S.Struct({
  provider: S.optionalKey(S.String),
  prompt: S.optionalKey(S.String),
  split: S.optionalKey(S.Boolean),
  resumeFrom: S.optionalKey(S.String),
});
export type AgentNewArgs = typeof AgentNewArgs.Type;
export const agentNewCommand = encodeRegisteredCommand("agent.new", AgentNewArgs);

export const AgentPromptArgs = S.Struct({
  target: S.String,
  text: S.String,
  id: S.optionalKey(S.String),
  delivery: S.optionalKey(S.Literals(["steer", "queue"])),
  resume: S.optionalKey(S.Boolean),
  replace: S.optionalKey(S.String),
  wait: S.optionalKey(S.Boolean),
  until: S.optionalKey(ProcessStateSchema),
  timeout: S.optionalKey(S.Int.check(S.isGreaterThanOrEqualTo(0))),
});
export type AgentPromptArgs = typeof AgentPromptArgs.Type;
export const agentPromptCommand = encodeRegisteredCommand("agent.prompt", AgentPromptArgs);

export const AgentWatchArgs = S.Struct({
  target: S.String,
  after: S.optionalKey(S.Int.check(S.isGreaterThanOrEqualTo(0))),
});
export type AgentWatchArgs = typeof AgentWatchArgs.Type;
export const agentWatchCommand = encodeRegisteredCommand("agent.watch", AgentWatchArgs);

export const AgentInterruptArgs = S.Struct({
  ...sessionTarget,
  reason: S.optionalKey(S.String),
});
export type AgentInterruptArgs = typeof AgentInterruptArgs.Type;
export const agentInterruptCommand = encodeRegisteredCommand("agent.interrupt", AgentInterruptArgs);

export const AgentCompactArgs = S.Struct({
  ...sessionTarget,
  instructions: S.optionalKey(S.String),
});
export type AgentCompactArgs = typeof AgentCompactArgs.Type;
export const agentCompactCommand = encodeRegisteredCommand("agent.compact", AgentCompactArgs);

export const AgentPermissionArgs = S.Struct({
  ...sessionTarget,
  request: S.String,
  decision: PermissionDecisionSchema,
  feedback: S.optionalKey(S.String),
});
export type AgentPermissionArgs = typeof AgentPermissionArgs.Type;
export const agentPermissionCommand = encodeRegisteredCommand(
  "agent.permission",
  AgentPermissionArgs,
);

export const AgentListArgs = S.Struct({});
export type AgentListArgs = typeof AgentListArgs.Type;
export const agentListCommand = encodeRegisteredCommand("agent.list", AgentListArgs);

export const AgentGetArgs = S.Struct({ target: S.String });
export type AgentGetArgs = typeof AgentGetArgs.Type;
export const agentGetCommand = encodeRegisteredCommand("agent.get", AgentGetArgs);

export const AgentLogsArgs = S.Struct({
  target: S.String,
  lines: S.optionalKey(S.Int),
});
export type AgentLogsArgs = typeof AgentLogsArgs.Type;
export const agentLogsCommand = encodeRegisteredCommand("agent.logs", AgentLogsArgs);
