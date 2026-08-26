import { STATE_GLYPH } from "@danielfgray/amux/detect.ts";
import { ProcessState } from "@danielfgray/amux/process-state.ts";
import type { ProcessDisplayFacts, ProcessDisplayResult } from "@danielfgray/amux/plugin/process-display.ts";

/**
 * The agent-facing vocabulary that refines core's neutral `ProcessState`:
 * `failed` and `detached` are not process states, they are what this plugin
 * concludes from the neutral facts (`exitCode`, `detached`) a session backend
 * already exposes. This is the one place that conclusion is drawn — sidebar
 * rows and window tabs both call it, rather than each re-deriving it.
 *
 * Rank preserves the pre-refactor STATE_GLYPH priority: blocked wants
 * attention most, a failure or a still-running turn tie below it, a lost
 * attachment ranks above merely idle, and a clean finish wants the least.
 */
const RANK = {
  [ProcessState.Blocked]: 4,
  [ProcessState.Running]: 3,
  [ProcessState.Idle]: 1,
  [ProcessState.Done]: 0,
} satisfies Record<ProcessState, number>;

export function deriveProcessDisplay(facts: ProcessDisplayFacts): ProcessDisplayResult {
  if (facts.state === ProcessState.Done && facts.exitCode !== null && facts.exitCode !== 0) {
    return { glyph: "!", label: "failed", rank: 3 };
  }
  if (facts.detached && facts.state !== ProcessState.Done) {
    return { glyph: "⊘", label: "detached", rank: 2 };
  }
  return { glyph: STATE_GLYPH[facts.state], label: facts.state, rank: RANK[facts.state] };
}
