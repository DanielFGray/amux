import { expect, test } from "bun:test";
import { ProcessState } from "./process-state.ts";
import { ProcessStateArbiter, ProcessStateAuthority } from "./process-state-arbiter.ts";

test("an unknown higher-authority source does not displace a confident lower source", () => {
  const arbiter = new ProcessStateArbiter();
  arbiter.register({ authority: ProcessStateAuthority.Harness, state: () => "unknown" });
  arbiter.register({
    authority: ProcessStateAuthority.Detector,
    state: () => ProcessState.Blocked,
  });
  expect(arbiter.state).toBe(ProcessState.Blocked);
});

test("a harness-owned pane is not overridden by a detector heuristic", () => {
  const arbiter = new ProcessStateArbiter();
  arbiter.register({ authority: ProcessStateAuthority.Harness, state: () => ProcessState.Running });
  arbiter.register({
    authority: ProcessStateAuthority.Detector,
    state: () => ProcessState.Blocked,
  });
  expect(arbiter.state).toBe(ProcessState.Running);
});
