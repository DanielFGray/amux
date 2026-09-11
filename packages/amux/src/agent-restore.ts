/**
 * Restore sequencing for foreign-agent resume — herdr's `pane_restore_startup`
 * and the pending-plan / geometry gate, without the spawn itself.
 *
 * 1. History: a native resume redraws its own transcript. Seeding saved
 *    scrollback underneath doubles the conversation. Suppress whenever a
 *    restore plan exists (including duplicate panes that lost the claim).
 * 2. Geometry: do not start the agent while size is dirty or zero. An agent
 *    that lays out at the wrong width reflows badly; amux's settle signal is
 *    the first client size after restore (herdr waits for layout area > 0 and
 *    geometry_dirty=false).
 */
import { Context, Layer, Option } from "effect";
import {
  planAgentResumeFromSnapshot,
  type AgentResumeClaims,
  type AgentResumePlan,
} from "./agent-resume.ts";
import type { PaneAgentSessionSnapshot } from "./agent-session.ts";
import type { ForeignHarnessAdapterLookup } from "./foreign-harness.ts";
import { isTerminalSize } from "./limits.ts";

export type PaneRestoreStartup = {
  readonly restorePlan: Option.Option<AgentResumePlan>;
  /** ANSI (or other) history to seed the terminal; none under native resume. */
  readonly initialHistory: Option.Option<string>;
  readonly duplicateAgentSession: boolean;
  /** Dedupe key reserved by this call — release if spawn fails before start. */
  readonly reservedDedupeKey: Option.Option<string>;
};

export type AgentRestoreOptions = {
  readonly resumeEnabled: boolean;
  readonly claims: AgentResumeClaims;
  readonly adapters: ForeignHarnessAdapterLookup;
};

/**
 * Decide plan + history for one pane. Mirrors herdr
 * `persist/restore.rs::pane_restore_startup`.
 */
export const paneRestoreStartup = (
  session: PaneAgentSessionSnapshot | undefined,
  history: string | undefined,
  options: AgentRestoreOptions,
): PaneRestoreStartup => {
  const planned =
    session !== undefined && options.resumeEnabled
      ? planAgentResumeFromSnapshot(session, options.adapters)
      : Option.none();
  // Suppress history whenever a plan *could* be taken — including when this
  // pane loses the dedupe race. The agent (or the winning pane) owns redraw.
  const hasNativeAgentRestore = Option.isSome(planned);
  const taken = planned.pipe(Option.flatMap((plan) => options.claims.take(plan)));
  const duplicateAgentSession = hasNativeAgentRestore && Option.isNone(taken);

  return {
    restorePlan: taken,
    initialHistory:
      hasNativeAgentRestore || history === undefined ? Option.none() : Option.some(history),
    duplicateAgentSession,
    reservedDedupeKey: taken.pipe(Option.map((plan) => plan.dedupeKey)),
  };
};

export type PendingAgentResume = {
  readonly sessionId: string;
  readonly paneId?: string;
  readonly cwd?: string;
  readonly plan: AgentResumePlan;
  /** Other SessionSpec fields the flusher must preserve (env, stripEnv, …). */
  readonly extras?: {
    readonly kind?: "pty" | "component";
    readonly rpcPath?: string;
    readonly daemonSession?: string;
    readonly declaredAgent?: string;
  };
};

export type ReadyAgentResume = PendingAgentResume & {
  readonly cols: number;
  readonly rows: number;
};

export type ResumeGeometry = {
  readonly cols: number;
  readonly rows: number;
  /** When true, refuse to start — layout is still moving (herdr geometry_dirty). */
  readonly dirty?: boolean;
};

/**
 * Holds restore plans until geometry settles. First valid size wins per
 * session; a dirty pass yields nothing so a later settled pass can start.
 */
export interface PendingAgentResumes {
  readonly enqueue: (entry: PendingAgentResume) => void;
  readonly get: (sessionId: string) => PendingAgentResume | undefined;
  readonly has: (sessionId: string) => boolean;
  /** All session ids still waiting on geometry. */
  readonly sessionIds: () => readonly string[];
  /**
   * Take one pending resume if geometry is settled. Returns none while dirty
   * or when size is not a valid terminal size — the entry stays queued.
   */
  readonly takeReady: (
    sessionId: string,
    geometry: ResumeGeometry,
  ) => Option.Option<ReadyAgentResume>;
  /** Drain every ready pending resume under one geometry snapshot. */
  readonly takeAllReady: (geometry: ResumeGeometry) => readonly ReadyAgentResume[];
  /** Spawn failed before the process started — put the plan back. */
  readonly requeue: (entry: PendingAgentResume) => void;
  readonly clear: (sessionId: string) => void;
}

export class PendingAgentResumeScheduler implements PendingAgentResumes {
  readonly #pending = new Map<string, PendingAgentResume>();

  enqueue(entry: PendingAgentResume): void {
    this.#pending.set(entry.sessionId, entry);
  }

  get(sessionId: string): PendingAgentResume | undefined {
    return this.#pending.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.#pending.has(sessionId);
  }

  sessionIds(): readonly string[] {
    return [...this.#pending.keys()];
  }

  takeReady(sessionId: string, geometry: ResumeGeometry): Option.Option<ReadyAgentResume> {
    if (geometry.dirty === true) return Option.none();
    if (!isTerminalSize(geometry.cols, geometry.rows)) return Option.none();
    const entry = this.#pending.get(sessionId);
    if (!entry) return Option.none();
    this.#pending.delete(sessionId);
    return Option.some({
      ...entry,
      cols: geometry.cols,
      rows: geometry.rows,
    });
  }

  takeAllReady(geometry: ResumeGeometry): readonly ReadyAgentResume[] {
    if (geometry.dirty === true || !isTerminalSize(geometry.cols, geometry.rows)) return [];
    const ready: ReadyAgentResume[] = [];
    for (const sessionId of [...this.#pending.keys()]) {
      const taken = this.takeReady(sessionId, geometry);
      if (Option.isSome(taken)) ready.push(taken.value);
    }
    return ready;
  }

  requeue(entry: PendingAgentResume): void {
    this.#pending.set(entry.sessionId, entry);
  }

  clear(sessionId: string): void {
    this.#pending.delete(sessionId);
  }
}

export class PendingAgentResumesTag extends Context.Service<
  PendingAgentResumesTag,
  PendingAgentResumes
>()("amux/PendingAgentResumes") {}

export const PendingAgentResumesLive = Layer.sync(
  PendingAgentResumesTag,
  () => new PendingAgentResumeScheduler(),
);
