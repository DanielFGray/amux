/**
 * The one vocabulary for what an agent is allowed to do.
 *
 * Three planes speak it — the config file the user writes by hand, the project
 * database an approval records itself in, and the frames the harness and the
 * pane exchange — so, as with process-state, the words and their schemas are
 * defined once here and every union, guard and table constraint is derived from
 * them. A rule effect that exists in one module's spelling and not another's is
 * an action that is allowed on one plane and asked about on the next.
 *
 * This module deliberately depends on nothing but Effect: policy is evaluated
 * inside an agent worker, a daemon and a client, and none of them should inherit
 * the import graph of the others to ask a question about a string.
 */
import { Schema as S } from "effect";

/** What a rule says about an action: allow it, refuse it, or ask a human. */
export const PermissionEffectSchema = S.Literal("allow", "ask", "deny");
export type PermissionEffect = typeof PermissionEffectSchema.Type;

/**
 * What a human answers when asked.
 *
 * `always` is `once` plus a remembered rule, which is why the request carries
 * the patterns it would save: the answer is a choice between things the user
 * can see, not a promise the UI invents afterwards.
 */
export const PermissionDecisionSchema = S.Literal("once", "always", "reject");
export type PermissionDecision = typeof PermissionDecisionSchema.Type;

export const PermissionRuleSchema = S.Struct({
  /** The verb a tool declares: read, write, edit, bash. Wildcards allowed. */
  action: S.String,
  /** What the verb acts on — a project-relative path or a command. Wildcards allowed. */
  resource: S.String,
  effect: PermissionEffectSchema,
});
export type PermissionRule = typeof PermissionRuleSchema.Type;

/**
 * The policy in force before the user has written or approved anything.
 *
 * Stated as "ask about everything, except reading", so a tool added later is
 * gated by construction rather than by whoever adds it remembering to gate it.
 */
export const DEFAULT_RULES: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "ask" },
  { action: "read", resource: "*", effect: "allow" },
];

/**
 * Decide one action against one resource.
 *
 * Last match wins, so the ordering of the sources is the policy: defaults
 * first, then the config file, then what the user has approved in this project.
 * An action nobody has a rule for is asked about.
 *
 * A `deny` is the exception to last-match-wins: it holds wherever it appears in
 * the list. Otherwise a rule recorded by clicking "always" in one project would
 * quietly outrank the standing refusal the user wrote by hand, and a deny that
 * can be overridden from the UI is not a refusal. The cost is that a broad deny
 * cannot carry exceptions — write those as `ask` plus the allows.
 */
export function evaluate(
  action: string,
  resource: string,
  rules: readonly PermissionRule[],
): PermissionEffect {
  const matched = rules.filter(
    (rule) => matchWildcard(action, rule.action) && matchWildcard(resource, rule.resource),
  );
  if (matched.some((rule) => rule.effect === "deny")) return "deny";
  return matched.at(-1)?.effect ?? "ask";
}

/**
 * Decide an action that touches several resources at once — the segments of a
 * shell command, or a tool that names more than one path.
 *
 * A single `deny` refuses the whole call and a single `ask` blocks it, whatever
 * the other resources evaluate to: `ls && rm -rf /` is not two thirds allowed.
 */
export function evaluateAll(
  action: string,
  resources: readonly string[],
  rules: readonly PermissionRule[],
): PermissionEffect {
  const effects = resources.map((resource) => evaluate(action, resource, rules));
  if (effects.includes("deny")) return "deny";
  return effects.includes("ask") || effects.length === 0 ? "ask" : "allow";
}

/**
 * Glob-style match over a whole string: `*` for any run of characters, `?` for
 * one. Anchored at both ends, because a rule for `git status *` that also
 * matched `sudo git status` would be a rule the user cannot read.
 *
 * A trailing ` *` is treated as optional, so `git status *` covers the bare
 * `git status` and the user does not need two rules for one decision.
 */
export function matchWildcard(input: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/[*?]/g, (token) => (token === "*" ? ".*" : "."));
  const optionalTail = escaped.endsWith(" .*") ? `${escaped.slice(0, -3)}( .*)?` : escaped;
  return new RegExp(`^${optionalTail}$`, "s").test(input);
}
