import {
  ProcessState,
  type ProcessDisplayFacts,
  type ProcessDisplayResult,
} from "@danielfgray/amux";

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

const STATE_GLYPH = {
  [ProcessState.Blocked]: "●",
  [ProcessState.Running]: "⠹",
  [ProcessState.Idle]: "○",
  [ProcessState.Done]: "✓",
} satisfies Record<ProcessState, string>;

const SPINNER_FRAMES = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];

export function deriveProcessDisplay(facts: ProcessDisplayFacts): ProcessDisplayResult {
  if (facts.state === ProcessState.Done && facts.exitCode !== null && facts.exitCode !== 0) {
    return { glyph: "!", label: "failed", rank: 3 };
  }
  if (facts.detached && facts.state !== ProcessState.Done) {
    return { glyph: "⊘", label: "detached", rank: 2 };
  }
  // Only a running agent animates; every other state is a still glyph, and
  // `frames` being absent is what tells the renderer so.
  return {
    glyph: STATE_GLYPH[facts.state],
    frames: facts.state === ProcessState.Running ? SPINNER_FRAMES : undefined,
    label: facts.state,
    rank: RANK[facts.state],
  };
}
