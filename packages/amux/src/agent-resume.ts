/**
 * Turn a trusted agent session ref into resume argv — once.
 *
 * Borrowed from herdr's `src/agent_resume.rs` `plan` / `dedupe_key`. Per-harness
 * argv forms live on foreign-harness adapters (continuity plugin) behind
 * {@link PluginBehaviour.planResume}; this module owns the shared plan type,
 * dedupe claims, and the allowlist gate that refuses to consult an adapter for
 * an unofficial (source, agent) pair.
 */
import { Context, Duration, Effect, Layer, Match, Option, Schema as S } from "effect";
import {
  isOfficialAgentSource,
  type AgentSessionRef,
  type AgentSessionRefKind,
  type PaneAgentSessionSnapshot,
  persistedAgentSessionFromSnapshot,
} from "./agent-session.ts";
import { ForeignHarnessPlanResumeError } from "./foreign-harness.ts";
import { PluginBehaviour } from "./plugin-behaviour.ts";
import { errorMessage } from "./error-message.ts";

export const AgentResumePlanSchema = S.Struct({
  agent: S.String,
  argv: S.Array(S.String),
  dedupeKey: S.String,
});
export type AgentResumePlan = typeof AgentResumePlanSchema.Type;

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
 * Budget for one foreign-harness `planResume` call. In-process adapters answer
 * immediately; the limit bites a hung plugin-host round trip.
 */
export const PLAN_RESUME_TIMEOUT_MS = 2000;

/**
 * Ask {@link PluginBehaviour} for a resume plan under {@link PLAN_RESUME_TIMEOUT_MS}.
 * Failure or timeout yields none and a warning — that session takes the normal
 * spawn path.
 */
export const askPlanResume = (
  adapterId: string,
  ref: AgentSessionRef,
): Effect.Effect<Option.Option<AgentResumePlan>, never, PluginBehaviour> =>
  Effect.gen(function* () {
    const behaviour = yield* PluginBehaviour;
    return yield* behaviour.planResume(adapterId, ref).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(PLAN_RESUME_TIMEOUT_MS),
        orElse: () =>
          Effect.fail(
            new ForeignHarnessPlanResumeError({
              adapter: adapterId,
              message: `timed out after ${PLAN_RESUME_TIMEOUT_MS}ms`,
            }),
          ),
      }),
      Effect.catch((error) =>
        Effect.logWarning(
          `foreign harness planResume failed adapter=${adapterId} session=${ref.kind}:${ref.value}: ${errorMessage(error)}`,
        ).pipe(Effect.as(Option.none())),
      ),
    );
  });

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
): Effect.Effect<Option.Option<AgentResumePlan>> => {
  if (!kinds.has(sessionRef.kind)) return Effect.succeed(Option.none());
  return Effect.succeed(
    Option.some({
      agent,
      argv: resumeArgvFor(form, sessionRef.value),
      dedupeKey: agentResumeDedupeKey(source, agent, sessionRef),
    }),
  );
};

/**
 * Map an allowlisted (source, agent, ref) to resume argv via PluginBehaviour.
 * Unsupported pairs and missing adapters yield none. Adapter failure or timeout
 * also yields none (see {@link askPlanResume}).
 */
export const planAgentResume = (
  source: string,
  agent: string,
  sessionRef: AgentSessionRef,
): Effect.Effect<Option.Option<AgentResumePlan>, never, PluginBehaviour> =>
  Effect.gen(function* () {
    if (!isOfficialAgentSource(source, agent)) return Option.none();
    const behaviour = yield* PluginBehaviour;
    const declarations = yield* behaviour.declarations;
    const adapter = declarations.adapters.find(
      (entry) => entry.source === source && entry.id === agent,
    );
    if (adapter === undefined) return Option.none();
    return yield* askPlanResume(adapter.id, sessionRef);
  });

/** Re-validate a layout snapshot entry, then plan — restore's usual entry. */
export const planAgentResumeFromSnapshot = (
  snapshot: PaneAgentSessionSnapshot,
): Effect.Effect<Option.Option<AgentResumePlan>, never, PluginBehaviour> =>
  persistedAgentSessionFromSnapshot(snapshot).pipe(
    Option.match({
      onNone: () => Effect.succeed(Option.none()),
      onSome: ({ source, agent, sessionRef }) => planAgentResume(source, agent, sessionRef),
    }),
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
