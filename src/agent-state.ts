import net from "node:net";
import { Effect } from "effect";
import { sessionPaths } from "./session.ts";

export const AGENT_STATES = ["idle", "working", "blocked", "failed", "done"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export function reportAgentState(session: string, agent: string, state: AgentState): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const paths = yield* sessionPaths(session);
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const socket = net.createConnection(paths.agentState);
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
          }),
      );
    }),
  );
}
