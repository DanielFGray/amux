/**
 * Per-project persistence: one SQLite database for everything amux remembers
 * about one repository.
 *
 * The unit is the project because the facts are. A rule that lets an agent
 * write files is a statement about *this* checkout, and carrying it to the next
 * repository would be an approval the user never gave. Conversation history
 * (ts-010726) and the durable prompt inbox (ts-32cf77) are the same shape and
 * belong in the same database, which is why this module owns identity and
 * migration rather than a permission table.
 *
 * SQLite rather than a JSON document because two agents in one project answer
 * approvals concurrently: WAL is what makes that a solved problem instead of a
 * lock file we maintain ourselves.
 */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as FileSystem from "effect/FileSystem";
import { Clock, Context, Effect, Layer, Schema as S, type Scope } from "effect";
import * as Path from "effect/Path";
import { nodePath } from "./effect/node-path.ts";
import { PermissionEffectSchema, type PermissionRule } from "./permission.ts";
import { stateRoot } from "./session.ts";
import { errorMessage } from "./error-message.ts";

export class ProjectStoreError extends S.TaggedError<ProjectStoreError>()("ProjectStoreError", {
  operation: S.String,
  message: S.String,
}) {}

export type PromptDelivery = "steer" | "queue";
export type PromptOptions = {
  readonly id?: string;
  readonly delivery?: PromptDelivery;
  readonly resume?: boolean;
  readonly replace?: string;
};
export type PromptInboxEntry = {
  readonly id: string;
  readonly turn: string;
  readonly session: string;
  readonly prompt: string;
  readonly delivery: PromptDelivery;
  readonly admitted: number;
  readonly resume: boolean;
};

/** One row of the conversation table — enough for a resume picker. */
export type ConversationRecord = {
  readonly session: string;
  readonly conversation: string;
  readonly updated: number;
};

export interface Interface {
  /** The project this store belongs to — an absolute repository root. */
  readonly root: string;
  /** Rules the user has approved here, oldest first: the order `evaluate` reads as precedence. */
  readonly rules: Effect.Effect<readonly PermissionRule[], ProjectStoreError>;
  /** Record approvals. Re-deciding an action and resource moves the existing rule. */
  readonly addRules: (rules: readonly PermissionRule[]) => Effect.Effect<void, ProjectStoreError>;
  /** The provider-valid conversation for one daemon-owned agent session. */
  readonly conversation: (session: string) => Effect.Effect<string | undefined, ProjectStoreError>;
  /** Every stored conversation for this project, newest update first. */
  readonly listConversations: Effect.Effect<readonly ConversationRecord[], ProjectStoreError>;
  /** Replace one complete provider-valid conversation after a provider step settles. */
  readonly saveConversation: (
    session: string,
    conversation: string,
  ) => Effect.Effect<void, ProjectStoreError>;
  /** Copy a stored conversation onto another session id (resume into a new session). */
  readonly copyConversation: (
    from: string,
    to: string,
  ) => Effect.Effect<boolean, ProjectStoreError>;
  /** Admit a prompt durably. Reusing an id is safe only for the same request. */
  readonly admitPrompt: (
    session: string,
    prompt: string,
    delivery: PromptDelivery,
    resume?: boolean,
    id?: string,
  ) => Effect.Effect<PromptInboxEntry, ProjectStoreError>;
  /** Pending prompts in admission order. Promoted rows remain durable history. */
  readonly pendingPrompts: (
    session: string,
  ) => Effect.Effect<readonly PromptInboxEntry[], ProjectStoreError>;
  readonly promotePrompt: (id: string) => Effect.Effect<void, ProjectStoreError>;
  /** Rewrite an unpromoted admission in place (edit text or flip queue→steer). */
  readonly updatePendingPrompt: (
    id: string,
    patch: { readonly prompt?: string; readonly delivery?: PromptDelivery },
  ) => Effect.Effect<PromptInboxEntry, ProjectStoreError>;
  /** Instruction file paths already surfaced to one session. */
  readonly attachedInstructions: (
    session: string,
  ) => Effect.Effect<ReadonlySet<string>, ProjectStoreError>;
  /** Record instruction files as surfaced. Re-attaching a path is a no-op. */
  readonly attachInstructions: (
    session: string,
    paths: readonly string[],
  ) => Effect.Effect<void, ProjectStoreError>;
}

export class Service extends Context.Service<Service, Interface>()("amux/ProjectStore") {}

/** Open (and migrate) the database for one project, closing it with the scope. */
export const layer = (
  root: string,
): Layer.Layer<Service, ProjectStoreError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Service, open(root));

/**
 * Where a project's state lives.
 *
 * The basename keeps the directory recognisable to a human reading `ls`; the
 * digest is what makes it unique, because two checkouts of `api` under
 * different parents are different projects.
 */
export function projectSlug(root: string): string {
  const path = nodePath;
  const absolute = path.resolve(root);
  const digest = createHash("sha256").update(absolute).digest("hex").slice(0, 8);
  return `${path.basename(absolute) || "root"}-${digest}`;
}

export const projectDirectory = (root: string): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(yield* stateRoot(), "amux", "projects", projectSlug(root));
  });

/**
 * Schema history, applied in order against `PRAGMA user_version`.
 *
 * SQLite already stores the schema version, so a migrations table would be a
 * second copy of a fact the file knows about itself. Append migrations; never
 * edit one that has shipped.
 *
 * The `effect` constraint is built from the schema's own literals so the
 * database cannot disagree with the type about what a rule may say.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE project (root TEXT NOT NULL);
   CREATE TABLE permission_rule (
     id       TEXT PRIMARY KEY,
     action   TEXT NOT NULL,
     resource TEXT NOT NULL,
     effect   TEXT NOT NULL CHECK (effect IN (${PermissionEffectSchema.literals
       .map((literal) => `'${literal}'`)
       .join(", ")})),
     created  INTEGER NOT NULL
   );
    CREATE UNIQUE INDEX permission_rule_unique ON permission_rule (action, resource);`,
  `CREATE TABLE conversation (
      session      TEXT PRIMARY KEY,
      conversation TEXT NOT NULL,
      updated      INTEGER NOT NULL
     );`,
  `CREATE TABLE prompt_inbox (
      id       TEXT PRIMARY KEY,
      session  TEXT NOT NULL,
      prompt   TEXT NOT NULL,
      delivery TEXT NOT NULL CHECK (delivery IN ('steer', 'queue')),
      admitted INTEGER NOT NULL,
      resume   INTEGER NOT NULL DEFAULT 1,
      promoted INTEGER
    );
   CREATE INDEX prompt_inbox_pending ON prompt_inbox (session, promoted, admitted);`,
  `ALTER TABLE prompt_inbox ADD COLUMN turn TEXT;
   UPDATE prompt_inbox SET turn = 'turn-' || id WHERE turn IS NULL;`,
  `CREATE TABLE instruction_attachment (
      session TEXT NOT NULL,
      path    TEXT NOT NULL,
      PRIMARY KEY (session, path)
    );`,
];

const open = (
  root: string,
): Effect.Effect<Interface, ProjectStoreError, Scope.Scope | FileSystem.FileSystem | Path.Path> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* projectDirectory(root);
      // 0o700: a project's database holds what its agents may do to it.
      yield* fs
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(
          Effect.mapError(
            (error) => new ProjectStoreError({ operation: "open", message: error.message }),
          ),
        );
      const path = yield* Path.Path;
      const database = yield* attempt(
        "open",
        () => new Database(path.join(directory, "amux.db"), { create: true }),
      );
      yield* attempt("migrate", () => migrate(database, root));
      return database;
    }),
    (database) => Effect.sync(() => database.close(false)),
  ).pipe(Effect.map((database) => queries(database, root)));

function migrate(database: Database, root: string): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  const applied =
    database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  for (const [index, statements] of MIGRATIONS.entries()) {
    if (index < applied) continue;
    database.transaction(() => {
      database.exec(statements);
      // The pragma takes no bound parameter, and the value is a loop index.
      database.exec(`PRAGMA user_version = ${index + 1}`);
    })();
  }
  // Written after migration rather than in it: a directory scan is how any
  // index over projects is rebuilt, so every database must name its own root
  // even if it was created by an older schema.
  database.run("DELETE FROM project");
  database.run("INSERT INTO project (root) VALUES (?)", [root]);
}

function queries(database: Database, root: string): Interface {
  const select = database.query<PermissionRule, []>(
    "SELECT action, resource, effect FROM permission_rule ORDER BY created, id",
  );
  const insert = database.query(
    `INSERT INTO permission_rule (id, action, resource, effect, created)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (action, resource)
     DO UPDATE SET effect = excluded.effect, created = excluded.created`,
  );
  const selectConversation = database.query<{ conversation: string }, [string]>(
    "SELECT conversation FROM conversation WHERE session = ?",
  );
  const selectConversations = database.query<ConversationRecord, []>(
    "SELECT session, conversation, updated FROM conversation ORDER BY updated DESC, session",
  );
  const saveConversation = database.query(
    `INSERT INTO conversation (session, conversation, updated) VALUES (?, ?, ?)
     ON CONFLICT (session) DO UPDATE SET conversation = excluded.conversation, updated = excluded.updated`,
  );
  type StoredPrompt = Omit<PromptInboxEntry, "resume"> & { readonly resume: number };
  const promptEntry = (row: StoredPrompt): PromptInboxEntry => ({
    ...row,
    resume: row.resume !== 0,
  });
  const selectPrompt = database.query<StoredPrompt, [string]>(
    "SELECT id, turn, session, prompt, delivery, admitted, resume FROM prompt_inbox WHERE id = ?",
  );
  const insertPrompt = database.query(
    "INSERT INTO prompt_inbox (id, turn, session, prompt, delivery, admitted, resume) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const selectPending = database.query<StoredPrompt, [string]>(
    "SELECT id, turn, session, prompt, delivery, admitted, resume FROM prompt_inbox WHERE session = ? AND promoted IS NULL ORDER BY admitted, id",
  );
  const markPrompt = database.query(
    "UPDATE prompt_inbox SET promoted = ? WHERE id = ? AND promoted IS NULL",
  );
  const updatePending = database.query(
    `UPDATE prompt_inbox
        SET prompt = COALESCE(?, prompt),
            delivery = COALESCE(?, delivery)
      WHERE id = ? AND promoted IS NULL`,
  );
  const selectAttached = database.query<{ path: string }, [string]>(
    "SELECT path FROM instruction_attachment WHERE session = ?",
  );
  const insertAttached = database.query(
    "INSERT OR IGNORE INTO instruction_attachment (session, path) VALUES (?, ?)",
  );
  return {
    root,
    rules: attempt("rules", () => select.all()),
    addRules: (rules) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* attempt("addRules", () =>
          database.transaction(() => {
            for (const rule of rules)
              insert.run(randomUUID(), rule.action, rule.resource, rule.effect, now);
          })(),
        );
      }),
    conversation: (session) =>
      attempt("conversation", () => selectConversation.get(session)?.conversation),
    listConversations: attempt("listConversations", () => selectConversations.all()),
    saveConversation: (session, conversation) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* attempt("saveConversation", () =>
          saveConversation.run(session, conversation, now),
        );
      }),
    copyConversation: (from, to) =>
      Effect.gen(function* () {
        if (from === to) return true;
        const now = yield* Clock.currentTimeMillis;
        return yield* attempt("copyConversation", () => {
          const source = selectConversation.get(from)?.conversation;
          if (source === undefined) return false;
          saveConversation.run(to, source, now);
          return true;
        });
      }),
    admitPrompt: (session, prompt, delivery, resume = true, requestedId = randomUUID()) =>
      Effect.gen(function* () {
        const admitted = yield* Clock.currentTimeMillis;
        return yield* attempt("admitPrompt", () =>
          database.transaction(() => {
            const existing = selectPrompt.get(requestedId);
            if (existing) {
              if (
                existing.session !== session ||
                existing.prompt !== prompt ||
                existing.delivery !== delivery
              )
                throw new Error(
                  `prompt id '${requestedId}' was already admitted with different contents`,
                );
              return promptEntry(existing);
            }
            const turn = `turn-${requestedId}`;
            insertPrompt.run(
              requestedId,
              turn,
              session,
              prompt,
              delivery,
              admitted,
              resume ? 1 : 0,
            );
            return { id: requestedId, turn, session, prompt, delivery, admitted, resume };
          })(),
        );
      }),
    pendingPrompts: (session) =>
      attempt("pendingPrompts", () => selectPending.all(session).map(promptEntry)),
    promotePrompt: (id) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* attempt("promotePrompt", () => markPrompt.run(now, id));
      }),
    updatePendingPrompt: (id, patch) =>
      attempt("updatePendingPrompt", () =>
        database.transaction(() => {
          const result = updatePending.run(patch.prompt ?? null, patch.delivery ?? null, id);
          if (result.changes === 0) throw new Error(`prompt id '${id}' is not a pending admission`);
          const updated = selectPrompt.get(id);
          if (!updated) throw new Error(`prompt id '${id}' vanished during update`);
          return promptEntry(updated);
        })(),
      ),
    attachedInstructions: (session) =>
      attempt(
        "attachedInstructions",
        () => new Set(selectAttached.all(session).map((row) => row.path)),
      ),
    attachInstructions: (session, paths) =>
      attempt("attachInstructions", () =>
        database.transaction(() => {
          for (const path of paths) insertAttached.run(session, path);
        })(),
      ),
  };
}

const attempt = <A>(operation: string, body: () => A) =>
  Effect.try({
    try: body,
    catch: (error) => new ProjectStoreError({ operation, message: errorMessage(error) }),
  });

/**
 * Sync project root for reducer paths that cannot await `projectRoot`.
 * Same git-common-dir rule as `git.ts` — worktrees collapse to one project.
 */
export function projectRootSync(dir: string): string {
  const path = nodePath;
  const absolute = path.resolve(dir);
  const result = Bun.spawnSync(
    ["git", "-C", absolute, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode === 0) {
    const common = result.stdout.toString().trim();
    if (common.length > 0) return path.dirname(common);
  }
  return absolute;
}

const stateRootSync = (): string => {
  // @effect-diagnostics-next-line processEnv:off -- sync mirror of session.stateRoot for reducers
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) return xdg;
  // @effect-diagnostics-next-line processEnv:off
  const home = process.env.HOME;
  return nodePath.join(home && home.length > 0 ? home : homedir(), ".local", "state");
};

export const projectDatabasePathSync = (root: string): string =>
  nodePath.join(stateRootSync(), "amux", "projects", projectSlug(root), "amux.db");

/**
 * Copy a conversation onto a new session id before the worker spawns.
 * Used from `agent.new` reduce so ResumeAgent loads the resumed history.
 */
export function copyConversationSync(cwd: string, from: string, to: string): boolean {
  if (from === to) return true;
  const dbPath = projectDatabasePathSync(projectRootSync(cwd));
  if (!existsSync(dbPath)) return false;
  const database = new Database(dbPath);
  try {
    const source = database
      .query<{ conversation: string }, [string]>(
        "SELECT conversation FROM conversation WHERE session = ?",
      )
      .get(from)?.conversation;
    if (source === undefined) return false;
    database
      .query(
        `INSERT INTO conversation (session, conversation, updated) VALUES (?, ?, ?)
         ON CONFLICT (session) DO UPDATE SET conversation = excluded.conversation, updated = excluded.updated`,
      )
      .run(to, source, Date.now());
    return true;
  } finally {
    database.close(false);
  }
}

/** Short label for a picker row — first user-ish text blob in the JSON export. */
export function conversationPreview(conversation: string, maxLen = 72): string {
  try {
    const parsed = JSON.parse(conversation) as unknown;
    const text = firstUserText(parsed);
    if (text !== undefined) {
      const oneLine = text.replace(/\s+/g, " ").trim();
      if (oneLine.length === 0) return "(empty)";
      return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
    }
  } catch {
    // fall through
  }
  return "(conversation)";
}

const firstUserText = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUserText(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.role === "user") {
    if (typeof record.content === "string" && record.content.trim() !== "") return record.content;
    if (Array.isArray(record.content)) {
      for (const part of record.content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: string }).text === "string"
        ) {
          const text = (part as { text: string }).text.trim();
          if (text.length > 0) return text;
        }
      }
    }
  }
  for (const child of Object.values(record)) {
    const found = firstUserText(child);
    if (found !== undefined) return found;
  }
  return undefined;
};
