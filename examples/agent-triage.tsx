/** @jsxImportSource @opentui/solid */
import { For, createMemo } from "solid-js";
import { Effect } from "effect";
import type { PluginDefinition } from "../src/plugin/types.ts";

type TriageAgent = {
  id: string;
  label: string;
  state: string;
  reason: string;
  space: string;
  exited: boolean;
};

/** A read-only attention rail assembled from the public value projections. */
const agentTriage: PluginDefinition = {
  id: "example.agent-triage",
  apiVersion: "1",
  effect: (ctx) =>
    Effect.sync(() => {
      const agents = createMemo<readonly TriageAgent[]>(() => {
        ctx.panel.tick();
        return ctx.panel
          .display()
          .rows.filter((row) => row.kind === "agent" && row.agentId)
          .map((row) => ({
            id: row.agentId!,
            label: row.agentCliKind ?? row.title ?? row.foregroundCommand ?? "pty",
            state: row.exited ? "done" : (row.agentState ?? "idle"),
            reason: row.exited
              ? "exited"
              : row.agentState === "blocked"
                ? "needs input"
                : row.unseen
                  ? "unseen"
                  : row.scrolled
                    ? "scrolled"
                    : "working",
            space: row.spaceName,
            exited: !!row.exited,
          }))
          .sort((a, b) => score(b) - score(a));
      });

      const panel = {
        id: "example.agent-triage.panel",
        region: "right" as const,
        anchor: "app" as const,
        title: "triage",
        size: () => 30,
        component: () => (
          <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
            <text style={{ height: 1, fg: "#f9e2af" }}>
              {() => ` TRIAGE ${attentionCount(agents())}/${agents().length} `}
            </text>
            <For each={agents()}>
              {(agent) => (
                <text style={{ height: 1, fg: color(agent) }}>
                  {() =>
                    ` ${glyph(agent)} ${agent.label.slice(0, 12)} ${agent.reason.slice(0, 12)} `
                  }
                </text>
              )}
            </For>
          </box>
        ),
      };

      ctx.registerPanel(panel);
    }),
};

export default agentTriage;

function score(agent: TriageAgent): number {
  if (agent.state === "blocked") return 4;
  if (agent.reason === "unseen") return 3;
  if (agent.reason === "scrolled") return 2;
  if (agent.exited) return 1;
  return 0;
}

function attentionCount(agents: readonly TriageAgent[]): number {
  return agents.filter((agent) => score(agent) > 0).length;
}

function glyph(agent: TriageAgent): string {
  if (agent.state === "blocked") return "!";
  if (agent.exited) return "x";
  if (agent.reason === "unseen") return "*";
  if (agent.reason === "scrolled") return "~";
  return ">";
}

function color(agent: TriageAgent): string {
  if (agent.state === "blocked") return "#f38ba8";
  if (agent.exited) return "#6c7086";
  if (agent.reason === "unseen") return "#fab387";
  return "#cdd6f4";
}
