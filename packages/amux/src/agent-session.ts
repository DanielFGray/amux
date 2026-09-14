/**
 * Foreign-agent conversation identity: accept what a pane reports about which
 * conversation it is in, safely enough that the stored ref can later become
 * argv on restore (ep-c96a99 / herdr's agent_resume.rs).
 *
 * Core owns this boundary because the allowlist is a remote-ish code-execution
 * gate: a rejected report is the difference between resuming Claude and
 * spawning whatever an untrusted pane process asked for. The layout snapshot
 * stores the same `{source, agent, kind, value}` shape and re-runs these
 * validators on load; resume argv lives in `agent-resume.ts`.
 */
import { Option, Schema as S } from "effect";
import { NonEmptyString, PositiveInt } from "./schema-primitives.ts";

export const MAX_AGENT_SESSION_ID_LEN = 512;
export const MAX_AGENT_SESSION_PATH_LEN = 4096;

/** Source string paired with exactly one agent. Anything else is refused. */
const OFFICIAL_AGENT_SOURCES = {
  "amux:claude": "claude",
  "amux:codex": "codex",
  "amux:copilot": "copilot",
  "amux:devin": "devin",
  "amux:droid": "droid",
  "amux:kimi": "kimi",
  "amux:omp": "omp",
  "amux:mastracode": "mastracode",
  "amux:pi": "pi",
  "amux:hermes": "hermes",
  "amux:opencode": "opencode",
  "amux:qodercli": "qodercli",
  "amux:qwen": "qwen",
  "amux:kilo": "kilo",
  "amux:cursor": "cursor",
  "amux:antigravity_cli": "agy",
  "amux:grok": "grok",
} as const satisfies Record<string, string>;

export type OfficialAgentSource = keyof typeof OFFICIAL_AGENT_SOURCES;
export type OfficialAgent = (typeof OFFICIAL_AGENT_SOURCES)[OfficialAgentSource];

export const AgentSessionRefKind = S.Literals(["id", "path"]);
export type AgentSessionRefKind = typeof AgentSessionRefKind.Type;

export const AgentSessionRefSchema = S.Struct({
  kind: AgentSessionRefKind,
  value: NonEmptyString,
});
export type AgentSessionRef = typeof AgentSessionRefSchema.Type;

/** Lifecycle cmux/herdr hooks report alongside a session id (hibernation gate). */
export const AgentLifecycleSchema = S.Literals(["running", "idle", "needsInput", "unknown"]);
export type AgentLifecycle = typeof AgentLifecycleSchema.Type;

const SESSION_START_SOURCES = [
  "startup",
  "resume",
  "clear",
  "compact",
  "branch",
  "new",
  "fork",
  "select",
] as const;
export type SessionStartSource = (typeof SESSION_START_SOURCES)[number];

export const AgentSessionRecordSchema = S.Struct({
  paneId: NonEmptyString,
  source: NonEmptyString,
  agent: NonEmptyString,
  sessionRef: AgentSessionRefSchema,
  seq: S.Finite,
  lifecycle: S.optional(AgentLifecycleSchema),
  pid: S.optional(PositiveInt),
});
export type AgentSessionRecord = typeof AgentSessionRecordSchema.Type;

/**
 * On-disk / layout form of a trusted ref — what herdr's PaneAgentSessionSnapshot
 * carries. No seq/lifecycle/pid: those are live-only. Re-validated through
 * `sessionRefFromSnapshot` on the way back in; a snapshot is user-writable.
 */
export const PaneAgentSessionSnapshotSchema = S.Struct({
  source: NonEmptyString,
  agent: NonEmptyString,
  kind: AgentSessionRefKind,
  value: NonEmptyString,
});
export type PaneAgentSessionSnapshot = typeof PaneAgentSessionSnapshotSchema.Type;

export const paneAgentSessionSnapshot = (
  record: Pick<AgentSessionRecord, "source" | "agent" | "sessionRef">,
): PaneAgentSessionSnapshot => ({
  source: record.source,
  agent: record.agent,
  kind: record.sessionRef.kind,
  value: record.sessionRef.value,
});

export type AgentSessionReport = {
  readonly paneId: string;
  readonly source: string;
  readonly agent: string;
  readonly seq: number;
  readonly agentSessionId?: string;
  readonly agentSessionPath?: string;
  /** Present on a subagent event — must never replace the pane's root id. */
  readonly agentId?: string;
  readonly sessionStartSource?: string;
  readonly lifecycle?: AgentLifecycle;
  readonly pid?: number;
};

export type AgentSessionRejectReason =
  | "unknown_source"
  | "mismatched_source"
  | "invalid_ref"
  | "subagent"
  | "stale_seq"
  | "noise_replacement";

export type AgentSessionApplyResult =
  | { readonly _tag: "accepted"; readonly record: AgentSessionRecord }
  | { readonly _tag: "rejected"; readonly reason: AgentSessionRejectReason };

const hasControlChars = (value: string): boolean => {
  for (const ch of value) {
    if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) return true;
  }
  return false;
};

export const officialAgentForSource = (source: string): OfficialAgent | undefined => {
  if (Object.hasOwn(OFFICIAL_AGENT_SOURCES, source)) {
    return OFFICIAL_AGENT_SOURCES[source as OfficialAgentSource];
  }
  return undefined;
};

/** Load-bearing allowlist: reported refs become restore argv. */
export const isOfficialAgentSource = (source: string, agent: string): boolean =>
  officialAgentForSource(source) === agent;

export const agentSessionRefId = (value: string): Option.Option<AgentSessionRef> => {
  if (value.length === 0 || value.length > MAX_AGENT_SESSION_ID_LEN || hasControlChars(value)) {
    return Option.none();
  }
  return Option.some({ kind: "id", value });
};

export const agentSessionRefPath = (value: string): Option.Option<AgentSessionRef> => {
  // Absolute means rooted, not "exists": a Path ref becomes restore argv, so a
  // relative one would resolve against whatever cwd the daemon happens to have.
  // Unix absolute paths start with `/`; Windows drive/UNC forms are accepted so
  // a snapshot from another host is still rejected for the same reasons as a
  // relative path rather than silently reinterpreted.
  const absolute =
    value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  if (
    value.length === 0 ||
    value.length > MAX_AGENT_SESSION_PATH_LEN ||
    hasControlChars(value) ||
    !absolute
  ) {
    return Option.none();
  }
  return Option.some({ kind: "path", value });
};

export const sessionRefFromReport = (
  source: string,
  agent: string,
  agentSessionId: string | undefined,
  agentSessionPath: string | undefined,
): Option.Option<AgentSessionRef> => {
  if (!isOfficialAgentSource(source, agent)) return Option.none();
  if (agent === "pi" || agent === "omp") {
    return (agentSessionPath ? agentSessionRefPath(agentSessionPath) : Option.none()).pipe(
      Option.orElse(() => (agentSessionId ? agentSessionRefId(agentSessionId) : Option.none())),
    );
  }
  return agentSessionId ? agentSessionRefId(agentSessionId) : Option.none();
};

/** Re-validate a snapshot entry the same way a live report is validated. */
export const sessionRefFromSnapshot = (
  source: string,
  agent: string,
  kind: AgentSessionRefKind,
  value: string,
): Option.Option<AgentSessionRef> => {
  if (!isOfficialAgentSource(source, agent)) return Option.none();
  if (kind === "path") {
    if (agent !== "pi" && agent !== "omp") return Option.none();
    return agentSessionRefPath(value);
  }
  return agentSessionRefId(value);
};

/** Drop a hand-edited or stale snapshot entry that would not pass the allowlist. */
export const persistedAgentSessionFromSnapshot = (
  snapshot: PaneAgentSessionSnapshot,
): Option.Option<Pick<AgentSessionRecord, "source" | "agent" | "sessionRef">> =>
  sessionRefFromSnapshot(snapshot.source, snapshot.agent, snapshot.kind, snapshot.value).pipe(
    Option.map((sessionRef) => ({
      source: snapshot.source,
      agent: snapshot.agent,
      sessionRef,
    })),
  );

export const normalizeSessionStartSource = (
  value: string | undefined,
): SessionStartSource | undefined => {
  const trimmed = value?.trim();
  return SESSION_START_SOURCES.find((source) => source === trimmed);
};

/**
 * Gate other features (notifications, auto-naming, hibernation) ask before
 * treating a report as the pane's root conversation. A subagent payload must
 * never win this.
 */
export const isRootSessionReport = (report: Pick<AgentSessionReport, "agentId">): boolean =>
  report.agentId === undefined || report.agentId === "";

const sameRef = (left: AgentSessionRef, right: AgentSessionRef): boolean =>
  left.kind === right.kind && left.value === right.value;

/**
 * Pure apply: given the pane's current record (and last accepted seq for this
 * source), decide whether a report replaces, refreshes, or is refused.
 */
export const applyAgentSessionReport = (
  current: AgentSessionRecord | undefined,
  lastSeq: number | undefined,
  report: AgentSessionReport,
): AgentSessionApplyResult => {
  const expected = officialAgentForSource(report.source);
  if (expected === undefined) return { _tag: "rejected", reason: "unknown_source" };
  if (expected !== report.agent) return { _tag: "rejected", reason: "mismatched_source" };
  if (!isRootSessionReport(report)) return { _tag: "rejected", reason: "subagent" };
  if (lastSeq !== undefined && report.seq <= lastSeq) {
    return { _tag: "rejected", reason: "stale_seq" };
  }

  const sessionRef = Option.getOrUndefined(
    sessionRefFromReport(
      report.source,
      report.agent,
      report.agentSessionId,
      report.agentSessionPath,
    ),
  );
  if (!sessionRef) return { _tag: "rejected", reason: "invalid_ref" };

  const sessionStart = normalizeSessionStartSource(report.sessionStartSource);
  if (current && !sameRef(current.sessionRef, sessionRef) && sessionStart === undefined) {
    return { _tag: "rejected", reason: "noise_replacement" };
  }

  const record = {
    paneId: report.paneId,
    source: report.source,
    agent: report.agent,
    sessionRef,
    seq: report.seq,
  };
  const withLifecycle =
    report.lifecycle === undefined ? record : { ...record, lifecycle: report.lifecycle };
  const accepted = report.pid === undefined ? withLifecycle : { ...withLifecycle, pid: report.pid };
  return { _tag: "accepted", record: accepted };
};

/** In-memory table keyed by pane id — conversation follows the pane. */
export class AgentSessionTable {
  readonly #records = new Map<string, AgentSessionRecord>();
  readonly #seqs = new Map<string, number>();

  get(paneId: string): AgentSessionRecord | undefined {
    return this.#records.get(paneId);
  }

  /** Every pane currently holding a trusted session ref. */
  entries(): ReadonlyMap<string, AgentSessionRecord> {
    return this.#records;
  }

  report(report: AgentSessionReport): AgentSessionApplyResult {
    const seqKey = `${report.paneId}\0${report.source}`;
    const result = applyAgentSessionReport(
      this.#records.get(report.paneId),
      this.#seqs.get(seqKey),
      report,
    );
    if (result._tag === "rejected") return result;
    this.#seqs.set(seqKey, report.seq);
    this.#records.set(report.paneId, result.record);
    return result;
  }

  /**
   * Seed from a re-validated layout snapshot. No seq: the next live report for
   * this source is always newer than "nothing ordered yet".
   */
  load(paneId: string, snapshot: PaneAgentSessionSnapshot): boolean {
    const loaded = Option.getOrUndefined(persistedAgentSessionFromSnapshot(snapshot));
    if (!loaded) return false;
    this.#records.set(paneId, {
      paneId,
      source: loaded.source,
      agent: loaded.agent,
      sessionRef: loaded.sessionRef,
      seq: 0,
    });
    return true;
  }

  clear(paneId: string): void {
    this.#records.delete(paneId);
    for (const key of [...this.#seqs.keys()]) {
      if (key.startsWith(`${paneId}\0`)) this.#seqs.delete(key);
    }
  }
}
