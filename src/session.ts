import path from "node:path";
import { homedir } from "node:os";
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Clock, Context, Data, Effect, Exit, Option, Schema as S } from "effect";
import { decodeLayout, layoutPanes } from "./layout.ts";
import {
  MAX_AGENTS,
  MAX_LAYOUT_BYTES,
  MAX_SESSION_BYTES,
  MAX_SPACES,
  MAX_WINDOWS,
} from "./limits.ts";

export class SessionEnv extends Context.Reference<SessionEnv>()("SessionEnv", {
  defaultValue: () => process.env,
}) {}

export class SessionId extends Context.Tag("SessionId")<SessionId, string>() {}

/** On-disk format. Additive changes must bump neither version nor consumers. */
export const SESSION_VERSION = 1;

/**
 * A session id becomes a single directory name under the sessions root, so it
 * must be a bounded, filename-safe, single path component: generous enough for
 * "default", UUIDs, and human names, small enough to fit any filesystem's
 * component limit with room to spare.
 */
export const MAX_SESSION_ID_LENGTH = 128;

export class SessionIdError extends S.TaggedError<SessionIdError>()("SessionIdError", {
  message: S.String,
}) {}

export class SessionStateError extends S.TaggedError<SessionStateError>()("SessionStateError", {
  message: S.String,
}) {}

export class SessionSizeError extends S.TaggedError<SessionSizeError>()("SessionSizeError", {
  message: S.String,
}) {}

export interface SessionService {
  readonly load: (id: string) => Effect.Effect<SessionState | null, SessionIdError>;
  readonly save: (
    state: SessionState,
  ) => Effect.Effect<void, SessionIdError | SessionStateError | SessionSizeError | PlatformError>;
  readonly readLease: (id: string) => Effect.Effect<SessionLease | null, SessionIdError>;
  readonly writeLease: (lease: SessionLease) => Effect.Effect<void, SessionIdError | PlatformError>;
  readonly remove: (id: string) => Effect.Effect<void, SessionIdError | PlatformError>;
  readonly cleanupStale: Effect.Effect<string[], SessionIdError | PlatformError>;
  readonly exists: (id: string) => Effect.Effect<boolean>;
}

/**
 * Whether `id` is safe to use as a session's directory name.
 *
 * The whole string must be a single component made of ASCII letters, digits,
 * `.`, `_`, or `-`. The special components `.` and `..` are rejected, while
 * other dot-prefixed names remain valid filename-safe ids. Path separators and
 * control characters are not in the set, so they can never reach a path. The
 * checks are explicit charcode tests rather than a regex because `/^[...]+$/`
 * matches before a trailing newline in JavaScript, and that is exactly the
 * kind of control character this function exists to reject.
 */
export function isSessionId(id: string): boolean {
  if (id.length === 0 || id.length > MAX_SESSION_ID_LENGTH || id === "." || id === "..")
    return false;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    const safe =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 45 ||
      c === 46 ||
      c === 95;
    if (!safe) return false;
  }
  return true;
}

export interface PersistedAgent {
  id: string;
  name: string;
  kind?: "pty" | "agent";
  cmd: string[];
  cwd?: string;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode: number | null;
}

export interface PersistedWindow {
  number: number;
  name: string | null;
  agents: PersistedAgent[];
  /**
   * The split arrangement, as an encoded layout string (see layout.ts).
   *
   * A flat agent list cannot express arrangement, so without this a restored
   * window could only guess at one. Absent or null means "no arrangement was
   * recorded" — restore falls back to a preset rather than refusing.
   *
   * Which pane had focus is in here too, rather than beside it. It was once a
   * `focusedAgent` field, because a layout could only name a pane by its agent
   * and so could not distinguish two panes showing one agent; panes carry their
   * own ids now (layout.ts PaneRef), so the layout says it exactly and a field
   * next to it could only ever disagree with it.
   *
   * Zoom is deliberately not here: it is a transient view of a layout, not a
   * layout, the same reason exportLayout reads through it.
   */
  layout?: string | null;
}

export interface PersistedSpace {
  id: string;
  name: string;
  dir: string;
  activeWindow: number | null;
  windows: PersistedWindow[];
  worktree?: { branch: string; repo: string; path: string };
}

export interface SessionState {
  version: typeof SESSION_VERSION;
  id: string;
  createdAt: number;
  updatedAt: number;
  attached: boolean;
  spaces: PersistedSpace[];
  /** Space that was on screen, by id. Absent means "none recorded", and a
   *  restore falls back to the first space. */
  activeSpace?: string | null;
}

export interface SessionLease {
  version: typeof SESSION_VERSION;
  session: string;
  pid: number;
  socket: string;
  startedAt: number;
  heartbeatAt: number;
  /** Earliest claim time among current attachments; absent when detached. */
  attachedSince?: number;
  /** Most recent activity time among current attachments. */
  attachLastSeen?: number;
  /** Per-client liveness, since one dead attachment must not hide the others. */
  attachments?: SessionAttachment[];
}

export interface SessionAttachment {
  client: string;
  attachedSince: number;
  attachLastSeen: number;
}

const NonEmptyString = S.String.pipe(S.minLength(1));
const PositiveInt = S.Int.pipe(S.greaterThan(0));
const NonNegativeNumber = S.Number.pipe(S.greaterThanOrEqualTo(0));
const SessionIdSchema = S.String.pipe(
  S.filter(isSessionId, { message: () => "invalid session id" }),
);
const TerminalDimension = S.Int.pipe(S.greaterThan(0), S.lessThanOrEqualTo(1_000));
const LayoutMetadataSchema = S.Struct({ focus: S.optional(S.Unknown) });

const PersistedAgentSchema = S.Struct({
  id: NonEmptyString,
  name: S.String,
  kind: S.optional(S.Literal("pty", "agent")),
  cmd: S.Array(NonEmptyString).pipe(S.minItems(1)),
  cwd: S.optional(S.String),
  cols: TerminalDimension,
  rows: TerminalDimension,
  exited: S.Boolean,
  exitCode: S.NullOr(S.Int),
}).pipe(
  S.filter(({ cols, rows }) => cols * rows <= 500_000, {
    message: () => "terminal size is too large",
  }),
);

const PersistedWindowSchema = S.Struct({
  number: PositiveInt,
  name: S.NullOr(S.String),
  agents: S.Array(PersistedAgentSchema),
  layout: S.optional(S.NullOr(S.String)),
});

const PersistedSpaceSchema = S.Struct({
  id: NonEmptyString,
  name: S.String,
  dir: S.String,
  activeWindow: S.NullOr(PositiveInt),
  windows: S.Array(PersistedWindowSchema),
  worktree: S.optional(S.Struct({ branch: S.String, repo: S.String, path: S.String })),
});

export const SessionStateSchema = S.Struct({
  version: S.Literal(SESSION_VERSION),
  id: SessionIdSchema,
  createdAt: NonNegativeNumber,
  updatedAt: NonNegativeNumber,
  attached: S.Boolean,
  spaces: S.Array(PersistedSpaceSchema).pipe(
    S.filter((spaces) => spaces.length <= MAX_SPACES, {
      message: () => `session has too many spaces`,
    }),
  ),
  activeSpace: S.optional(S.NullOr(S.String)),
});

export const SessionLeaseSchema = S.Struct({
  version: S.Literal(SESSION_VERSION),
  session: SessionIdSchema,
  pid: PositiveInt,
  socket: NonEmptyString,
  startedAt: NonNegativeNumber,
  heartbeatAt: NonNegativeNumber,
  attachedSince: S.optional(NonNegativeNumber),
  attachLastSeen: S.optional(NonNegativeNumber),
  attachments: S.optional(
    S.Array(
      S.Struct({
        client: NonEmptyString,
        attachedSince: NonNegativeNumber,
        attachLastSeen: NonNegativeNumber,
      }),
    ).pipe(S.maxItems(64)),
  ),
});

export interface SessionPaths {
  root: string;
  state: string;
  backup: string;
  lease: string;
  lock: string;
  socket: string;
  /**
   * The attach stream socket, separate from the RPC one.
   *
   * Two sockets because they are two different things: `socket` answers a
   * request and hangs up, while `attach` is a connection whose lifetime *is*
   * the attachment — its EOF is how the daemon learns a client died. Putting
   * both on one listener would mean a one-shot status call could not be told
   * from an attachment going away.
   */
  attach: string;
  control: string;
}

export function sessionRoot(): Effect.Effect<string, never, SessionEnv> {
  return Effect.map(SessionEnv, (env) =>
    path.join(
      env.XDG_STATE_HOME || path.join(env.HOME || homedir(), ".local", "state"),
      "amux",
      "sessions",
    ),
  );
}

/** Root directory for space worktrees, siblings to the sessions root. */
export function worktreesRoot(): Effect.Effect<string, never, SessionEnv> {
  return Effect.map(SessionEnv, (env) =>
    path.join(
      env.XDG_STATE_HOME || path.join(env.HOME || homedir(), ".local", "state"),
      "amux",
      "worktrees",
    ),
  );
}

export function sessionPaths(id: string): Effect.Effect<SessionPaths, SessionIdError, SessionEnv> {
  return Effect.gen(function* () {
    if (!isSessionId(id)) {
      return yield* new SessionIdError({ message: `invalid session id ${JSON.stringify(id)}` });
    }
    const root = yield* sessionRoot();
    const rootPath = path.join(root, id);
    return {
      root: rootPath,
      state: path.join(rootPath, "session.json"),
      backup: path.join(rootPath, "session.json.prev"),
      lease: path.join(rootPath, "lease.json"),
      lock: path.join(rootPath, "daemon.lock"),
      socket: path.join(rootPath, "daemon.sock"),
      attach: path.join(rootPath, "attach.sock"),
      control: path.join(rootPath, "control.sock"),
    };
  });
}

export function parseSessionState(
  value: unknown,
  expectedId?: string,
): Effect.Effect<SessionState, SessionStateError> {
  return Effect.gen(function* () {
    const state = yield* S.decodeUnknown(SessionStateSchema)(value).pipe(
      Effect.mapError(schemaError),
    );
    if (expectedId !== undefined && state.id !== expectedId) return yield* invalidState;
    const spaces = state.spaces;
    if (spaces.length > MAX_SPACES) return yield* tooManySpaces;
    const spaceIds = new Set<string>();
    const paneIds = new Set<string>();
    let windowCount = 0;
    let agentCount = 0;
    for (const item of spaces) {
      if (spaceIds.has(item.id)) return yield* invalidSpace;
      spaceIds.add(item.id);
      windowCount += item.windows.length;
      if (windowCount > MAX_WINDOWS) return yield* tooManyWindows;
      const numbers = new Set<number>();
      for (const candidate of item.windows) {
        if (numbers.has(candidate.number)) return yield* invalidWindow;
        if (
          candidate.layout !== undefined &&
          candidate.layout !== null &&
          Buffer.byteLength(candidate.layout) > MAX_LAYOUT_BYTES
        )
          return yield* invalidWindow;
        numbers.add(candidate.number);
        agentCount += candidate.agents.length;
        if (agentCount > MAX_AGENTS) return yield* tooManyAgents;
        const owned = new Map<string, boolean>();
        for (const entry of candidate.agents) {
          if (owned.has(entry.id)) return yield* invalidAgent;
          owned.set(entry.id, entry.exited);
        }
        if (candidate.layout) {
          const raw = yield* S.decodeUnknown(S.parseJson(LayoutMetadataSchema))(
            candidate.layout,
          ).pipe(Effect.mapError(schemaError));
          const layout = yield* Effect.try({
            try: () => decodeLayout(candidate.layout!),
            catch: (error) => new SessionStateError({ message: String(error) }),
          });
          if (raw.focus !== undefined && layout.focus !== raw.focus) return yield* layoutFocus;
          for (const pane of layoutPanes(layout.root)) {
            if (paneIds.has(pane.id)) return yield* duplicatePane(pane.id);
            paneIds.add(pane.id);
            if (!owned.has(pane.agent) || owned.get(pane.agent)) {
              return yield* absentAgent(pane.id);
            }
          }
        }
      }
      if (item.activeWindow !== null && !numbers.has(item.activeWindow)) {
        return yield* missingWindow;
      }
    }
    if (
      state.activeSpace !== undefined &&
      state.activeSpace !== null &&
      !spaceIds.has(state.activeSpace)
    ) {
      return yield* missingSpace;
    }
    return structuredClone(state) as unknown as SessionState;
  });
}

const invalidState = new SessionStateError({ message: "invalid session state" });
const tooManySpaces = new SessionStateError({ message: "session has too many spaces" });
const invalidSpace = new SessionStateError({ message: "invalid persisted space" });
const tooManyWindows = new SessionStateError({ message: "session has too many windows" });
const invalidWindow = new SessionStateError({ message: "invalid persisted window" });
const tooManyAgents = new SessionStateError({ message: "session has too many agents" });
const invalidAgent = new SessionStateError({ message: "invalid persisted agent" });
const layoutFocus = new SessionStateError({ message: "layout focus names no pane" });
const missingWindow = new SessionStateError({ message: "active window does not exist" });
const missingSpace = new SessionStateError({ message: "active space does not exist" });
const duplicatePane = (id: string) =>
  new SessionStateError({ message: `duplicate pane id '${id}'` });
const absentAgent = (id: string) =>
  new SessionStateError({ message: `pane '${id}' names an absent or exited agent` });

function schemaError(error: unknown): SessionStateError {
  const message = String(error);
  if (message.includes("session has too many spaces")) return tooManySpaces;
  if (message.includes('["agents"]')) return invalidAgent;
  if (message.includes('["windows"]')) return invalidWindow;
  if (message.includes('["spaces"]')) return invalidSpace;
  return invalidState;
}

function validState(value: unknown, expectedId?: string): value is SessionState {
  return Exit.isSuccess(Effect.runSync(Effect.exit(parseSessionState(value, expectedId))));
}

const jsonFile = <A, I>(path: string, schema: S.Schema<A, I>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs
      .stat(path)
      .pipe(
        Effect.catchTag("SystemError", (error) =>
          error.reason === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
        ),
      );
    if (info === null) return Option.none();
    if (info.size > MAX_SESSION_BYTES) return Option.none();
    const text = yield* fs.readFileString(path);
    return S.decodeUnknownOption(S.parseJson(schema))(text);
  });

export class Session extends Effect.Service<Session>()("Session", {
  accessors: true,
  effect: Effect.gen(function* () {
    const env = yield* SessionEnv;
    const fs = yield* FileSystem.FileSystem;
    const paths = (id: string) => sessionPaths(id).pipe(Effect.provideService(SessionEnv, env));

    const load = Effect.fnUntraced(function* (id: string) {
      const sessionPaths = yield* paths(id);
      const current = yield* jsonFile(sessionPaths.state, SessionStateSchema);
      if (Option.isSome(current) && validState(current.value, id)) return current.value;
      const backup = yield* jsonFile(sessionPaths.backup, SessionStateSchema);
      return Option.isSome(backup) && validState(backup.value, id) ? backup.value : null;
    });

    const save = Effect.fnUntraced(function* (state: SessionState) {
      yield* parseSessionState(state);
      const paths = yield* sessionPaths(state.id).pipe(Effect.provideService(SessionEnv, env));
      yield* fs.makeDirectory(paths.root, { recursive: true, mode: 0o700 });
      const temp = `${paths.state}.${process.pid}.tmp`;
      const updatedAt = yield* Clock.currentTimeMillis;
      const bytes =
        JSON.stringify({ ...state, version: SESSION_VERSION, updatedAt }, null, 2) + "\n";
      if (Buffer.byteLength(bytes) > MAX_SESSION_BYTES)
        return yield* new SessionSizeError({ message: "session state is too large" });
      yield* fs.writeFileString(temp, bytes, { mode: 0o600 });
      const tempFile = yield* fs.open(temp, { flag: "r+" });
      yield* tempFile.sync;
      yield* fs
        .rename(paths.state, paths.backup)
        .pipe(
          Effect.catchTag("SystemError", (error) =>
            error.reason === "NotFound" ? Effect.void : Effect.fail(error),
          ),
        );
      yield* fs.rename(temp, paths.state);
      const directory = yield* fs.open(paths.root, { flag: "r" });
      yield* directory.sync;
    }, Effect.scoped);

    const readLease = Effect.fnUntraced(function* (id: string) {
      const sessionPaths = yield* paths(id);
      const lease = yield* jsonFile(sessionPaths.lease, SessionLeaseSchema);
      if (Option.isNone(lease) || lease.value.session !== id) return null;
      return lease.value;
    });

    const writeLease = (lease: SessionLease) =>
      Effect.gen(function* () {
        const paths = yield* sessionPaths(lease.session);
        yield* fs.makeDirectory(paths.root, { recursive: true, mode: 0o700 });
        const temp = `${paths.lease}.${process.pid}.tmp`;
        yield* fs.writeFileString(temp, JSON.stringify(lease) + "\n", { mode: 0o600 });
        yield* fs.rename(temp, paths.lease);
      }).pipe(Effect.provideService(SessionEnv, env));

    const remove = (id: string) =>
      Effect.flatMap(paths(id), (sessionPaths) =>
        fs.remove(sessionPaths.root, { recursive: true, force: true }),
      );

    const cleanupStale = Effect.gen(function* () {
      const root = yield* sessionRoot();
      const entries = yield* fs
        .readDirectory(root)
        .pipe(
          Effect.catchTag("SystemError", (error) =>
            error.reason === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
          ),
        );
      const removed: string[] = [];
      for (const id of entries) {
        if (!isSessionId(id)) continue;
        const paths = yield* sessionPaths(id);
        const locked = yield* fs.stat(paths.lock).pipe(
          Effect.map(() => true),
          Effect.catchTag("SystemError", (error) =>
            error.reason === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
          ),
        );
        if (locked) continue;
        const lease = yield* readLease(id);
        if (lease && processAlive(lease.pid)) continue;
        yield* remove(id);
        removed.push(id);
      }
      return removed;
    }).pipe(Effect.provideService(SessionEnv, env));

    const exists = Effect.fnUntraced(function* (id: string) {
      return yield* paths(id).pipe(
        Effect.flatMap((sessionPaths) =>
          fs.stat(sessionPaths.root).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ),
        Effect.orElseSucceed(() => false),
      );
    });

    return {
      load,
      save,
      readLease,
      writeLease,
      remove,
      cleanupStale,
      exists,
    };
  }),
}) {}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === "EPERM";
  }
}
