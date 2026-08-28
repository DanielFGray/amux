import { ProcessState } from "../process-state.ts";
import type { PluginContributions, PluginInstance } from "./contributions.ts";

/** Fallback ranking when no plugin has registered a provider — order matches
 *  `space.ts`'s core rollUp (blocked wants attention most, done least). */
const NEUTRAL_RANK = {
  [ProcessState.Blocked]: 3,
  [ProcessState.Running]: 2,
  [ProcessState.Idle]: 1,
  [ProcessState.Done]: 0,
} satisfies Record<ProcessState, number>;

/** The neutral facts core exposes about one supervised process — everything
 *  an agent-aware plugin needs to derive a richer presentation (`failed`,
 *  `detached`, …) without core naming those states itself. */
export interface ProcessDisplayFacts {
  readonly state: ProcessState;
  readonly exitCode: number | null;
  readonly detached: boolean;
}

export interface ProcessDisplayResult {
  readonly glyph: string;
  /** Optional animation frames chosen by the provider. Renderers only select
   * a frame; deciding that a state merits animation remains plugin policy. */
  readonly frames?: readonly string[];
  readonly label: string;
  /** How urgently this result wants attention, for rolling many sessions'
   *  results up into one window/space glyph — higher wins. Comparable only
   *  against other results from the same provider chain within one render;
   *  core never assigns meaning to the number itself. */
  readonly rank: number;
}

/** Answers a display for one process's facts, or defers by returning
 *  `undefined` — core's plain `ProcessState` glyph is always the fallback,
 *  so a client with no agent plugin loaded still gets a legible tab/row. */
export type ProcessDisplayProvider = (
  facts: ProcessDisplayFacts,
) => ProcessDisplayResult | undefined;

export interface ProcessDisplay {
  readonly register: (owner: PluginInstance, provider: ProcessDisplayProvider) => () => void;
  readonly display: (facts: ProcessDisplayFacts) => ProcessDisplayResult;
}

export type ProcessDisplayReader = Omit<ProcessDisplay, "register">;

/**
 * The seam that keeps core tab/row rendering from importing agent
 * presentation. A plugin registers a provider; core calls
 * `display()` and falls back to the neutral `ProcessState` glyph when no
 * provider answers. Named contributions the way `session-views.tsx` claims a
 * pane type, except every registration answers the same query rather than
 * claiming a name, so the first provider to answer wins.
 */
export function createProcessDisplay(contributions: PluginContributions): ProcessDisplay {
  const providers = contributions.table<ProcessDisplayProvider>();
  let nextId = 0;
  return {
    register: (owner, provider) => providers.add(owner, `provider-${nextId++}`, provider),
    display: (facts) => {
      for (const { value } of providers.all()) {
        const result = value(facts);
        if (result) return result;
      }
      return {
        glyph: "·",
        label: facts.state,
        rank: NEUTRAL_RANK[facts.state],
      };
    },
  };
}
