import { AgentState } from "./agent-state.ts";

export const AgentStateAuthority = {
  Terminal: 3,
  Harness: 2,
  SelfReport: 1,
  Detector: 0,
} as const;

export type AgentStateAnswer = AgentState | "unknown";

export interface AgentStateSource {
  readonly authority: number;
  readonly state: () => AgentStateAnswer;
}

/** Resolves independent state reports without exposing their provenance to readers. */
export class AgentStateArbiter {
  #sources: AgentStateSource[] = [];

  register(source: AgentStateSource): () => void {
    this.#sources.push(source);
    this.#sources.sort((left, right) => right.authority - left.authority);
    return () => {
      const index = this.#sources.indexOf(source);
      if (index >= 0) this.#sources.splice(index, 1);
    };
  }

  get state(): AgentState {
    for (const source of this.#sources) {
      const state = source.state();
      if (state !== "unknown") return state;
    }
    return AgentState.Idle;
  }
}
