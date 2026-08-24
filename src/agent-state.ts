/**
 * The one vocabulary for what an agent is doing.
 *
 * The wire (EventBus's session.state, the attach protocol's agent.status and
 * agent.prompt `until`, the process self-report socket) carries this only as
 * an opaque string: those transports must not need editing whenever this
 * vocabulary grows a state, so none of them import this module. Instead every
 * plane that means something by the value — the sidebar glyph, the socket a
 * foreign agent's hook writes, the agent plugin relabeling a generic
 * agent.status frame — validates and interprets it at its own boundary via
 * `isReportedAgentState`, and every union and `Record<AgentState, _>` derives
 * from the names and schemas defined once here.
 *
 * This module deliberately depends on nothing but Node and Effect: the leaf
 * modules that need the vocabulary (detect, backend) must not inherit the
 * import graph of the ones that route it.
 */
import net from "node:net";
import { Schema as S } from "effect";

/**
 * The name for every state, so no call site spells one out.
 *
 * A value and a type share this name deliberately: TypeScript keeps the two in
 * separate namespaces, so one import gives a call site both `AgentState.Idle`
 * to write and `AgentState` to annotate with.
 */
export const AgentState = {
  Idle: "idle",
  Working: "working",
  Blocked: "blocked",
  Failed: "failed",
  Done: "done",
  Detached: "detached",
} as const;

export const ReportedAgentStateSchema = S.Literal(
  AgentState.Idle,
  AgentState.Working,
  AgentState.Blocked,
  AgentState.Failed,
  AgentState.Done,
);
export type ReportedAgentState = typeof ReportedAgentStateSchema.Type;

/**
 * Schema for what amux can say about an agent: everything the agent can report,
 * plus the one fact only the mux is in a position to know — that the pane lost
 * it.
 */
export const AgentStateSchema = S.Literal(
  ...ReportedAgentStateSchema.literals,
  AgentState.Detached,
);
export type AgentState = typeof AgentStateSchema.Type;

export const isReportedAgentState = (value: unknown): value is ReportedAgentState =>
  ReportedAgentStateSchema.literals.includes(value as ReportedAgentState);

/**
 * Write one self-report to a session's agent-state socket.
 *
 * Takes the socket path rather than a session id: the caller that knows which
 * pane this is already knows where to write, and keeping session naming out of
 * here is what lets the vocabulary above stay dependency-free.
 */
export function reportAgentState(
  socketPath: string,
  agent: string,
  state: ReportedAgentState,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const request = JSON.stringify({
      id: `amux:agent-state:${Date.now()}`,
      method: "process.state",
      params: { session: agent, state },
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(500, () => finish(new Error("agent state request timed out")));
    socket.once("error", finish);
    socket.once("data", () => finish());
    socket.once("connect", () => socket.write(`${request}\n`));
  });
}
