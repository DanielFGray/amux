import { expect, test } from "bun:test";
import { AgentState } from "./agent-state.ts";
import { AgentStateArbiter, AgentStateAuthority } from "./agent-state-arbiter.ts";

test("an unknown higher-authority source does not displace a confident lower source", () => {
  const arbiter = new AgentStateArbiter();
  arbiter.register({ authority: AgentStateAuthority.Harness, state: () => "unknown" });
  arbiter.register({ authority: AgentStateAuthority.Detector, state: () => AgentState.Blocked });
  expect(arbiter.state).toBe(AgentState.Blocked);
});

test("a harness-owned pane is not overridden by a detector heuristic", () => {
  const arbiter = new AgentStateArbiter();
  arbiter.register({ authority: AgentStateAuthority.Harness, state: () => AgentState.Working });
  arbiter.register({ authority: AgentStateAuthority.Detector, state: () => AgentState.Blocked });
  expect(arbiter.state).toBe(AgentState.Working);
});
