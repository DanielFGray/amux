/**
 * The one vocabulary for what an agent is doing.
 *
 * Every plane carries this word — the attach protocol, the event bus, the
 * supervisor, the sidebar glyph, the socket a foreign agent's hook writes — and
 * a state that exists in one module's union and not another's is a state that
 * silently disappears somewhere along the wire. So it is defined once, as a
 * schema, and every union and every `Record<AgentState, _>` is derived from it.
 *
 * This module deliberately depends on nothing but Node and Effect: the leaf
 * modules that need the vocabulary (detect, backend) must not inherit the
 * import graph of the ones that route it.
 */
import net from "node:net";
import { Schema as S } from "effect";

/**
 * What an agent can say about itself, over the agent-state socket or the
 * `agent.status` frame.
 */
export const ReportedAgentState = S.Literal("idle", "working", "blocked", "failed", "done");
export type ReportedAgentState = typeof ReportedAgentState.Type;

/**
 * What amux can say about an agent: everything the agent can report, plus the
 * one fact only the mux is in a position to know — that the pane lost it.
 */
export const AgentState = S.Literal(...ReportedAgentState.literals, "detached");
export type AgentState = typeof AgentState.Type;

export const isReportedAgentState = (value: unknown): value is ReportedAgentState =>
  ReportedAgentState.literals.includes(value as ReportedAgentState);

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
      method: "agent.state",
      params: { agent, state },
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.setTimeout(500, () => finish(new Error("agent state request timed out")));
    socket.once("error", finish);
    socket.once("data", () => finish());
    socket.once("connect", () => socket.write(`${request}\n`));
  });
}
