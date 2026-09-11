/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js";
import { Effect } from "effect";
import { definePlugin, PanelTag, SlotsTag, type PluginDefinition } from "amux";
import { AgentAwarenessTag } from "../packages/agent-awareness/src/presence.ts";

/** A read-only agent roster built entirely on the public panel projection. */
const agentDashboard: PluginDefinition = definePlugin({
  id: "example.agent-dashboard",
  inject: [PanelTag, SlotsTag, AgentAwarenessTag],
  effect: () =>
    Effect.gen(function* () {
      const slots = yield* SlotsTag;
      const panelContext = yield* PanelTag;
      const awareness = yield* AgentAwarenessTag;
      const panel = {
        id: "example.agent-dashboard.panel",
        title: "agents",
        size: () => 2,
        component: () => {
          const lines = createMemo(() => {
            panelContext.tick();
            const display = panelContext.display();
            const agents = display.rows.filter((row) => row.kind === "agent" && !row.exited);
            const blocked = agents.filter(
              (row) => awareness.presence(row.agentId!)?.state === "blocked",
            ).length;
            const roster = agents.length
              ? agents
                  .map((agent) => {
                    const cli = awareness.presence(agent.agentId!)?.agent ?? "pty";
                    const state = agent.agentState ?? "idle";
                    return `${cli}:${state}`;
                  })
                  .join(" ")
              : "no agents";
            return [` agents ${agents.length} | blocked ${blocked} `, ` ${roster} `];
          });

          return (
            <box style={{ height: 2, flexDirection: "column", backgroundColor: "#1e1e2e" }}>
              <text style={{ height: 1, fg: "#f9e2af" }}>{lines()[0]}</text>
              <text style={{ height: 1, fg: "#a6e3a1" }}>{lines()[1]}</text>
            </box>
          );
        },
      };
      yield* slots.register({ slot: "bottom.app", occupant: panel });
    }),
});

export default agentDashboard;
