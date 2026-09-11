/**
 * Turn a trusted agent session ref into resume argv — once.
 *
 * Borrowed from herdr's `src/agent_resume.rs` `plan` / `dedupe_key`. Per-harness
 * argv forms live on `ForeignHarnessAdapter.planResume` (continuity plugin);
 * this module owns the shared plan type, dedupe claims, and the allowlist gate
 * that refuses to consult an adapter for an unofficial (source, agent) pair.
 */
import { Context, Layer, Match, Option } from "effect";
import {
  isOfficialAgentSource,
  type AgentSessionRef,
  type AgentSessionRefKind,
  type PaneAgentSessionSnapshot,
  persistedAgentSessionFromSnapshot,
} from "./agent-session.ts";
import type { ForeignHarnessAdapterLookup } from "./foreign-harness.ts";

export type AgentResumePlan = {
  readonly agent: string;
  readonly argv: readonly string[];
  readonly dedupeKey: string;
};

/** How the session value is threaded onto the argv — adapters pick one. */
export type ResumeArgvForm =
  | { readonly _tag: "flag"; readonly bin: string; readonly flag: string }
  | { readonly _tag: "joined"; readonly bin: string; readonly flag: string }
  | { readonly _tag: "subcommand"; readonly bin: string; readonly sub: string };

export const resumeArgvFor = (form: ResumeArgvForm, value: string): readonly string[] =>
  Match.valueTags(form, {
    flag: ({ bin, flag }) => [bin, flag, value],
    joined: ({ bin, flag }) => [bin, `${flag}=${value}`],
    subcommand: ({ bin, sub }) => [bin, sub, value],
  });

/** Stable across panes so restore can claim a conversation once. */
export const agentResumeDedupeKey = (
  source: string,
  agent: string,
  sessionRef: AgentSessionRef,
): string => `${source}\0${agent}\0${sessionRef.kind}\0${sessionRef.value}`;

/**
 * Build a plan from a verified argv form. Adapters call this from `planResume`
 * so kind gating and dedupe keys stay one place.
 */
export const planResumeWithForm = (
  source: string,
  agent: string,
  sessionRef: AgentSessionRef,
  kinds: ReadonlySet<AgentSessionRefKind>,
  form: ResumeArgvForm,
): Option.Option<AgentResumePlan> => {
  if (!kinds.has(sessionRef.kind)) return Option.none();
  return Option.some({
    agent,
    argv: resumeArgvFor(form, sessionRef.value),
    dedupeKey: agentResumeDedupeKey(source, agent, sessionRef),
  });
};

/**
 * Map an allowlisted (source, agent, ref) to resume argv via a registered
 * harness adapter. Unsupported pairs and missing adapters yield none.
 */
export const planAgentResume = (
  source: string,
  agent: string,
  sessionRef: AgentSessionRef,
  adapters: ForeignHarnessAdapterLookup,
): Option.Option<AgentResumePlan> => {
  if (!isOfficialAgentSource(source, agent)) return Option.none();
  const adapter = adapters.bySource(source);
  if (adapter === undefined || adapter.id !== agent) return Option.none();
  return adapter.planResume(sessionRef);
};

/** Re-validate a layout snapshot entry, then plan — restore's usual entry. */
export const planAgentResumeFromSnapshot = (
  snapshot: PaneAgentSessionSnapshot,
  adapters: ForeignHarnessAdapterLookup,
): Option.Option<AgentResumePlan> =>
  persistedAgentSessionFromSnapshot(snapshot).pipe(
    Option.flatMap(({ source, agent, sessionRef }) =>
      planAgentResume(source, agent, sessionRef, adapters),
    ),
  );

/**
 * Restore keeps one of these and skips any plan already claimed, so one
 * conversation is never resumed into two panes (shared transcript corruption).
 * `release` rolls a reservation back if spawn fails before the process starts
 * (herdr's reserved_agent_session rollback).
 */
export interface AgentResumeClaims {
  /** First claim wins; duplicate returns none. */
  readonly take: (plan: AgentResumePlan) => Option.Option<AgentResumePlan>;
  readonly release: (dedupeKey: string) => void;
  readonly has: (dedupeKey: string) => boolean;
}

export class AgentResumeClaimSet implements AgentResumeClaims {
  readonly #claimed = new Set<string>();

  take(plan: AgentResumePlan): Option.Option<AgentResumePlan> {
    if (this.#claimed.has(plan.dedupeKey)) return Option.none();
    this.#claimed.add(plan.dedupeKey);
    return Option.some(plan);
  }

  release(dedupeKey: string): void {
    this.#claimed.delete(dedupeKey);
  }

  has(dedupeKey: string): boolean {
    return this.#claimed.has(dedupeKey);
  }
}

export class AgentResumeClaimsTag extends Context.Service<
  AgentResumeClaimsTag,
  AgentResumeClaims
>()("amux/AgentResumeClaims") {}

export const AgentResumeClaimsLive = Layer.sync(
  AgentResumeClaimsTag,
  () => new AgentResumeClaimSet(),
);
