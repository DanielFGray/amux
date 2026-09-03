/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js";
import { Effect } from "effect";
import { definePlugin, type PluginDefinition } from "../packages/amux/src/plugin/types.ts";
import { PanelTag, RegionsTag } from "../packages/amux/src/plugin/services.ts";

/** A read-only agent roster built entirely on the public panel projection. */
const agentDashboard: PluginDefinition = definePlugin({
  id: "example.agent-dashboard",
  inject: [PanelTag, RegionsTag],
  effect: () =>
    Effect.gen(function* () {
      const regions = yield* RegionsTag;
      const panelContext = yield* PanelTag;
      const panel = {
        id: "example.agent-dashboard.panel",
        region: "bottom" as const,
        anchor: "app" as const,
        title: "agents",
        size: () => 2,
        component: () => {
          const lines = createMemo(() => {
            panelContext.tick();
            const display = panelContext.display();
            const agents = display.rows.filter((row) => row.kind === "agent");
            const roster = agents.length
              ? agents
                  .map((agent) => {
                    const state = agent.agentState ?? (agent.exited ? "done" : "idle");
                    return `${agent.agentCliKind ?? "pty"}:${state}`;
                  })
                  .join(" ")
              : "no agents";
            return [
              ` agents ${display.agentCount} | blocked ${display.blockedCount} `,
              ` ${roster} `,
            ];
          });

          return (
            <box style={{ height: 2, flexDirection: "column", backgroundColor: "#1e1e2e" }}>
              <text style={{ height: 1, fg: "#f9e2af" }}>{lines()[0]}</text>
              <text style={{ height: 1, fg: "#a6e3a1" }}>{lines()[1]}</text>
            </box>
          );
        },
      };
      yield* regions.register(panel);
    }),
});

export default agentDashboard;
