/**
 * Commutative command-constraint substrate (live-image plan move 4 / ts-6baa81).
 *
 * Interception is a table of contributions, not an ordered middleware chain.
 * Paper Def. 44: a chain is non-commutative because a middleware inserted before
 * another sees a different request, and neither order can be withdrawn without
 * disturbing the other. This module withholds that outcome — registrants claim
 * a fixed rank, never a position relative to each other.
 *
 * Cite: pending table (ts-5583b8) for role-keyed registration; permission.ts
 * for deny-wins + ranked sources. permission.ts is NOT migrated onto this —
 * the isolated tests prove the mapping.
 */
import { CommandError } from "./commands.ts";
import { matchWildcard, type PermissionEffect } from "./permission.ts";

/**
 * Evaluator-owned source ranks. Concatenation order is this list, never
 * registration order. One source per rank — a second claim is rejected the
 * way pending rejects a second grammar source.
 */
export const CONSTRAINT_RANKS = ["defaults", "config", "project", "runtime"] as const;
export type ConstraintRank = (typeof CONSTRAINT_RANKS)[number];

export type ConstraintEffect = PermissionEffect;

export type ConstraintRule = {
  readonly action: string;
  readonly resource: string;
  readonly effect: ConstraintEffect;
};

export type ConstraintSource = {
  readonly id: string;
  readonly rank: ConstraintRank;
  /** Lazy — same posture as pending strokes(). */
  readonly rules: () => readonly ConstraintRule[];
};

export type ConstraintTable = {
  register(source: ConstraintSource): () => void;
  /**
   * Combine every registered source for one (action, resource) query.
   * Registration order must not change the result.
   */
  decide(action: string, resource: string): ConstraintEffect;
  sources(): readonly { readonly id: string; readonly rank: ConstraintRank }[];
};

/**
 * Production default: unmatched calls are allowed. Data in the table — not a
 * decide() special case — so sources() / plugin.inspect can see it. The monoid
 * still returns ask on an empty match list (same as permission.evaluate).
 */
export const DEFAULT_CONSTRAINT_SOURCE: ConstraintSource = {
  id: "amux.constraints.defaults",
  rank: "defaults",
  rules: () => [{ action: "*", resource: "*", effect: "allow" }],
};

/**
 * Flatten sources in fixed rank order, then apply the permission monoid:
 * deny wins wherever it appears; otherwise last match wins; empty → ask.
 *
 * Exported so tests can assert the combine without a live table.
 */
export const combineConstraintRules = (
  ranked: readonly { readonly rank: ConstraintRank; readonly rules: readonly ConstraintRule[] }[],
  action: string,
  resource: string,
): ConstraintEffect => {
  const ordered = CONSTRAINT_RANKS.flatMap((rank) => {
    const entry = ranked.find((item) => item.rank === rank);
    return entry === undefined ? [] : entry.rules;
  });
  const matched = ordered.filter(
    (rule) => matchWildcard(action, rule.action) && matchWildcard(resource, rule.resource),
  );
  if (matched.some((rule) => rule.effect === "deny")) return "deny";
  return matched.at(-1)?.effect ?? "ask";
};

export function createConstraintTable(): ConstraintTable {
  const byRank = new Map<ConstraintRank, ConstraintSource>();
  const table: ConstraintTable = {
    register(source) {
      const taken = byRank.get(source.rank);
      if (taken !== undefined) {
        throw new Error(
          `constraint rank '${source.rank}' is already registered by '${taken.id}'`,
        );
      }
      byRank.set(source.rank, source);
      return () => {
        if (byRank.get(source.rank) === source) byRank.delete(source.rank);
      };
    },
    decide(action, resource) {
      const ranked = CONSTRAINT_RANKS.flatMap((rank) => {
        const source = byRank.get(rank);
        return source === undefined
          ? []
          : [{ rank, rules: source.rules() }];
      });
      return combineConstraintRules(ranked, action, resource);
    },
    sources() {
      return CONSTRAINT_RANKS.flatMap((rank) => {
        const source = byRank.get(rank);
        return source === undefined ? [] : [{ id: source.id, rank }];
      });
    },
  };
  // Every table owner goes through this factory — one registration site.
  table.register(DEFAULT_CONSTRAINT_SOURCE);
  return table;
}

/** Refuse a command when constraints decide deny. ask/allow proceed. */
export const refuseIfDenied = (
  table: ConstraintTable,
  commandName: string,
): CommandError | null => {
  if (table.decide(commandName, "*") !== "deny") return null;
  return new CommandError({ message: `command denied by constraint: ${commandName}` });
};
