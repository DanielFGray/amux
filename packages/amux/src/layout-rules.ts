/**
 * Ordered layout rules in config elect a tiling algorithm without plugin
 * closures. A rule names an algorithm id and a condition; election walks the
 * list in order and takes the first rule whose condition holds and whose
 * algorithm is registered. Bounds are inclusive non-negative integers; an
 * unstated bound is free.
 */
import { Schema as S } from "effect";
import type { TilingAlgorithm } from "./tiling-algorithm.ts";
import { defaultTilingAlgorithm } from "./tiling-algorithm-default.ts";

const NonNegativeInt = S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(0)));

export const LayoutRuleWhenSchema = S.Struct({
  minCols: S.optional(NonNegativeInt),
  maxCols: S.optional(NonNegativeInt),
  minRows: S.optional(NonNegativeInt),
  maxRows: S.optional(NonNegativeInt),
  /**
   * Space name the rule applies to; omit to match any workspace. Space ids are
   * opaque UUIDs and are not matched. If two spaces share a name, the rule
   * applies to both.
   */
  workspace: S.optional(S.String),
});
export type LayoutRuleWhen = typeof LayoutRuleWhenSchema.Type;

export const LayoutRuleSchema = S.Struct({
  algorithm: S.String.pipe(S.check(S.isMinLength(1))),
  when: LayoutRuleWhenSchema,
});
export type LayoutRule = typeof LayoutRuleSchema.Type;

export interface LayoutElectionViewport {
  readonly cols: number;
  readonly rows: number;
  /** Display name of the target space, when known. */
  readonly workspaceName?: string;
}

export function layoutRuleMatches(when: LayoutRuleWhen, viewport: LayoutElectionViewport): boolean {
  if (when.minCols !== undefined && viewport.cols < when.minCols) return false;
  if (when.maxCols !== undefined && viewport.cols > when.maxCols) return false;
  if (when.minRows !== undefined && viewport.rows < when.minRows) return false;
  if (when.maxRows !== undefined && viewport.rows > when.maxRows) return false;
  if (when.workspace !== undefined && viewport.workspaceName !== when.workspace) return false;
  return true;
}

/**
 * First matching registered rule wins; otherwise `selectedId` if registered;
 * otherwise the built-in default. A rule that names an unregistered algorithm
 * is skipped.
 */
export function resolveTilingAlgorithm(
  rules: readonly LayoutRule[],
  selectedId: string,
  algorithms: readonly TilingAlgorithm[],
  viewport: LayoutElectionViewport,
): TilingAlgorithm {
  const byId = new Map(algorithms.map((algorithm) => [algorithm.id, algorithm] as const));
  for (const rule of rules) {
    if (!layoutRuleMatches(rule.when, viewport)) continue;
    const matched = byId.get(rule.algorithm);
    if (matched !== undefined) return matched;
  }
  return byId.get(selectedId) ?? defaultTilingAlgorithm;
}
