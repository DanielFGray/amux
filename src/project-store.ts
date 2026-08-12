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
import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Schema as S, type Scope } from "effect";
import { basename, join, resolve } from "node:path";
import { PermissionEffectSchema, type PermissionRule } from "./permission.ts";
import { stateRoot } from "./session.ts";

export class ProjectStoreError extends S.TaggedError<ProjectStoreError>()("ProjectStoreError", {
  operation: S.String,
  message: S.String,
}) {}

export interface Interface {
  /** The project this store belongs to — an absolute repository root. */
  readonly root: string;
  /** Rules the user has approved here, oldest first: the order `evaluate` reads as precedence. */
  readonly rules: Effect.Effect<readonly PermissionRule[], ProjectStoreError>;
  /** Record approvals. Re-deciding an action and resource moves the existing rule. */
  readonly addRules: (
    rules: readonly PermissionRule[],
  ) => Effect.Effect<void, ProjectStoreError>;
}

export class Service extends Context.Tag("amux/ProjectStore")<Service, Interface>() {}

/** Open (and migrate) the database for one project, closing it with the scope. */
export const layer = (
  root: string,
): Layer.Layer<Service, ProjectStoreError, FileSystem.FileSystem> =>
  Layer.scoped(Service, open(root));

/**
 * Where a project's state lives.
 *
 * The basename keeps the directory recognisable to a human reading `ls`; the
 * digest is what makes it unique, because two checkouts of `api` under
 * different parents are different projects.
 */
export function projectSlug(root: string): string {
  const absolute = resolve(root);
  const digest = createHash("sha256").update(absolute).digest("hex").slice(0, 8);
  return `${basename(absolute) || "root"}-${digest}`;
}

export const projectDirectory = (root: string): Effect.Effect<string> =>
  Effect.map(stateRoot(), (state) => join(state, "amux", "projects", projectSlug(root)));

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
];

const open = (
  root: string,
): Effect.Effect<Interface, ProjectStoreError, Scope.Scope | FileSystem.FileSystem> =>
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
      const database = yield* attempt(
        "open",
        () => new Database(join(directory, "amux.db"), { create: true }),
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
  const applied = database.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version ?? 0;
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
  return {
    root,
    rules: attempt("rules", () => select.all()),
    addRules: (rules) =>
      attempt("addRules", () =>
        database.transaction(() => {
          const now = Date.now();
          for (const rule of rules)
            insert.run(randomUUID(), rule.action, rule.resource, rule.effect, now);
        })(),
      ),
  };
}

const attempt = <A>(operation: string, body: () => A) =>
  Effect.try({
    try: body,
    catch: (error) =>
      new ProjectStoreError({
        operation,
        message: error instanceof Error ? error.message : String(error),
      }),
  });
