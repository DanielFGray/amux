import { ProcessState } from "./process-state.ts";

export const ProcessStateAuthority = {
  Terminal: 3,
  Harness: 2,
  SelfReport: 1,
  Detector: 0,
} as const;

export type ProcessStateAnswer = ProcessState | "unknown";

export interface ProcessStateSource {
  readonly authority: number;
  readonly state: () => ProcessStateAnswer;
}

/** Resolves independent state reports without exposing their provenance to readers. */
export class ProcessStateArbiter {
  #sources: ProcessStateSource[] = [];

  register(source: ProcessStateSource): () => void {
    this.#sources.push(source);
    this.#sources.sort((left, right) => right.authority - left.authority);
    return () => {
      const index = this.#sources.indexOf(source);
      if (index >= 0) this.#sources.splice(index, 1);
    };
  }

  get state(): ProcessState {
    for (const source of this.#sources) {
      const state = source.state();
      if (state !== "unknown") return state;
    }
    return ProcessState.Idle;
  }
}
