import { randomUUID } from "node:crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Context, Duration, Effect, Layer, Option, Redacted, Schema as S } from "effect";
import { stateRoot } from "@danielfgray/amux/session.ts";
import { flock, flockUnlock } from "@danielfgray/amux/shim.ts";
import type { JsonValue } from "@danielfgray/amux/protocol";
import { JsonValueSchema } from "@danielfgray/amux/protocol";
import type { ServiceInterception } from "@danielfgray/amux";

export * as Credential from "./credential.ts";

export const ID = S.String.pipe(S.brand("Credential.ID"));
export type ID = typeof ID.Type;
export type Secret = Redacted.Redacted<string>;

export interface OAuth {
  readonly type: "oauth";
  readonly methodID: string;
  readonly refresh: Secret;
  readonly access: Secret;
  readonly expires: number;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}
export interface Key {
  readonly type: "key";
  readonly key: Secret;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}
export type Value = OAuth | Key;

export class OAuthRefreshError extends S.TaggedError<OAuthRefreshError>()("OAuthRefreshError", {
  message: S.String,
}) {}

export interface Info {
  readonly id: ID;
  readonly integrationID: string;
  readonly label: string;
  readonly value: Value;
}

export interface Interface {
  readonly all: Effect.Effect<Info[]>;
  readonly list: (integrationID: string) => Effect.Effect<Info[]>;
  readonly get: (id: ID) => Effect.Effect<Info | undefined>;
  readonly create: (input: {
    readonly integrationID: string;
    readonly value: Value;
    readonly label?: string;
  }) => Effect.Effect<Info>;
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>;
  /** Refresh and persist an OAuth value while holding the store's writer lock. */
  readonly refreshOAuth: (
    id: ID,
    now: number,
    refresh: (value: OAuth) => Effect.Effect<OAuth, OAuthRefreshError>,
  ) => Effect.Effect<Value | undefined>;
  readonly remove: (id: ID) => Effect.Effect<void>;
}

export interface Access {
  /** Absent means every integration; multiple interceptors intersect their sets. */
  readonly integrations?: ReadonlySet<string>;
  /** Absent means writable; any interceptor may attenuate the service to read-only. */
  readonly write?: boolean;
}

const mergeAccess = (left: Access, right: Access): Access => ({
  integrations:
    left.integrations === undefined
      ? right.integrations
      : right.integrations === undefined
        ? left.integrations
        : new Set([...left.integrations].filter((id) => right.integrations!.has(id))),
  write:
    left.write === undefined
      ? right.write
      : right.write === undefined
        ? left.write
        : left.write && right.write,
});

const credentialAccess: ServiceInterception<Interface, Access> = {
  empty: {},
  combine: mergeAccess,
  access: (service, metadata) => {
    const permits = (integrationID: string) => metadata().integrations?.has(integrationID) ?? true;
    const writable = () => metadata().write ?? true;
    const requireWrite = <A>(effect: Effect.Effect<A>, integrationID: string) =>
      writable() && permits(integrationID)
        ? effect
        : Effect.die(new Error(`credential access to '${integrationID}' is read-only`));
    const permitted = (id: ID) =>
      service.get(id).pipe(Effect.map((credential) => credential?.integrationID));
    return {
      all: service.all.pipe(Effect.map((rows) => rows.filter((row) => permits(row.integrationID)))),
      list: (integrationID) =>
        permits(integrationID) ? service.list(integrationID) : Effect.succeed([]),
      get: (id) =>
        service
          .get(id)
          .pipe(
            Effect.map((credential) =>
              credential && permits(credential.integrationID) ? credential : undefined,
            ),
          ),
      create: (input) => requireWrite(service.create(input), input.integrationID),
      update: (id, updates) =>
        permitted(id).pipe(
          Effect.flatMap((integrationID) =>
            integrationID ? requireWrite(service.update(id, updates), integrationID) : Effect.void,
          ),
        ),
      refreshOAuth: (id, now, refresh) =>
        permitted(id).pipe(
          Effect.flatMap((integrationID) =>
            integrationID
              ? requireWrite(service.refreshOAuth(id, now, refresh), integrationID)
              : Effect.as(Effect.void, undefined as Value | undefined),
          ),
        ),
      remove: (id) =>
        permitted(id).pipe(
          Effect.flatMap((integrationID) =>
            integrationID ? requireWrite(service.remove(id), integrationID) : Effect.void,
          ),
        ),
    };
  },
};

class ServiceId {}
export const Service = Object.assign(Context.Service<ServiceId, Interface>()("amux/Credential"), {
  interception: credentialAccess,
} as const);

const PersistedValue = S.Union([
  S.Struct({
    type: S.Literals(["key"]),
    key: S.String,
    metadata: S.optional(S.Record(S.String, JsonValueSchema)),
  }),
  S.Struct({
    type: S.Literals(["oauth"]),
    methodID: S.String,
    refresh: S.String,
    access: S.String,
    expires: S.Int.check(S.isGreaterThanOrEqualTo(0)),
    metadata: S.optional(S.Record(S.String, JsonValueSchema)),
  }),
]);
const PersistedInfo = S.Struct({
  id: S.String,
  integrationID: S.String,
  label: S.String,
  value: PersistedValue,
});
type Persisted = Readonly<S.Schema.Type<typeof PersistedInfo>>;

const redact = (value: Persisted["value"]): Value =>
  value.type === "key"
    ? { ...value, key: Redacted.make(value.key) }
    : { ...value, access: Redacted.make(value.access), refresh: Redacted.make(value.refresh) };

const unredact = (value: Value): Persisted["value"] =>
  value.type === "key"
    ? { ...value, key: Redacted.value(value.key) }
    : { ...value, access: Redacted.value(value.access), refresh: Redacted.value(value.refresh) };

const present = (row: Persisted): Info => ({ ...row, id: row.id as ID, value: redact(row.value) });

const decodeText = (text: string) => {
  const parsed = S.decodeOption(S.fromJsonString(S.Array(S.Unknown)))(text);
  if (Option.isNone(parsed)) return { valid: false, rows: [] };
  return {
    valid: true,
    rows: parsed.value.filter((row): row is Persisted => S.is(PersistedInfo)(row)),
  };
};

const paths = Effect.fnUntraced(function* (root: string) {
  const path = yield* Path.Path;
  const directory = path.join(root, "amux");
  return {
    directory,
    file: path.join(directory, "auth.json"),
    lock: path.join(directory, "auth.json.lock"),
  };
});

const lock = Effect.fnUntraced(function* (fd: number, shared: boolean) {
  for (;;) {
    const result = flock(fd, shared ? 1 : 2);
    if (result === 0) return;
    if (result !== 11 && result !== 35)
      return yield* Effect.die(new Error(`credential lock failed: errno ${result}`));
    yield* Effect.sleep("5 millis");
  }
});

const implementation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const nodeFs = yield* Effect.promise(() => import("node:fs"));
  const root = yield* stateRoot();
  const target = yield* paths(root);

  const readRows = Effect.fnUntraced(function* () {
    const text = yield* fs
      .readFileString(target.file)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("[]") : Effect.fail(error),
        ),
      );
    return decodeText(text);
  });

  // effect/FileSystem's File handle no longer exposes the raw fd flock needs
  // (v4 dropped it entirely), so the lock file is opened directly through
  // node:fs instead of through the FileSystem abstraction. Every other file
  // in this store still goes through `fs`; only the fd this advisory lock is
  // taken on has to bypass it.
  const withLock = <A, E, R>(shared: boolean, body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(target.directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(target.directory, 0o700);
      return yield* Effect.scoped(
        Effect.acquireUseRelease(
          Effect.sync(() => nodeFs.openSync(target.lock, "a+", 0o600)),
          (fd) =>
            fs
              .chmod(target.lock, 0o600)
              .pipe(
                Effect.andThen(lock(fd, shared)),
                Effect.andThen(
                  fs
                    .chmod(target.file, 0o600)
                    .pipe(
                      Effect.catchTag("PlatformError", (error) =>
                        error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
                      ),
                    ),
                ),
                Effect.andThen(body),
              ),
          (fd) =>
            Effect.sync(() => {
              flockUnlock(fd);
              nodeFs.closeSync(fd);
            }),
        ),
      );
    });

  const writeRows = Effect.fnUntraced(function* (rows: readonly Persisted[]) {
    yield* fs.makeDirectory(target.directory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(target.directory, 0o700);
    const temp = `${target.file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = yield* fs.open(temp, { flag: "wx", mode: 0o600 });
    yield* Effect.acquireUseRelease(
      Effect.succeed(handle),
      (file) =>
        file
          .writeAll(
            new TextEncoder().encode(
              S.encodeSync(S.fromJsonString(S.Array(S.Unknown)))(rows) + "\n",
            ),
          )
          .pipe(Effect.andThen(file.sync)),
      () => Effect.void,
    );
    yield* fs.chmod(temp, 0o600);
    yield* fs.rename(temp, target.file);
    const directory = yield* fs.open(target.directory, { flag: "r" });
    yield* Effect.acquireUseRelease(
      Effect.succeed(directory),
      (file) => file.sync,
      () => Effect.void,
    );
  });

  const read = <A>(body: (rows: readonly Persisted[]) => A) =>
    withLock(true, readRows().pipe(Effect.map((loaded) => body(loaded.rows))));
  const mutate = <A>(
    body: (rows: readonly Persisted[]) => { readonly rows: Persisted[]; readonly result: A },
  ) =>
    withLock(
      false,
      readRows().pipe(
        Effect.flatMap((loaded) => {
          if (!loaded.valid) return Effect.die(new Error("credential store contains invalid JSON"));
          const next = body(loaded.rows);
          return writeRows(next.rows).pipe(Effect.as(next.result));
        }),
      ),
    );

  return {
    all: read((rows) => rows.map(present)),
    list: (integrationID: string) =>
      read((rows) => rows.filter((row) => row.integrationID === integrationID).map(present)),
    get: (id: ID) =>
      read((rows) => {
        const row = rows.find((item) => item.id === id);
        return row ? present(row) : undefined;
      }),
    create: (input: Parameters<Interface["create"]>[0]) =>
      mutate((rows) => {
        const row: Persisted = {
          id: `cred_${randomUUID()}`,
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: unredact(input.value),
        };
        return { rows: [...rows, row], result: present(row) };
      }),
    update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) =>
      mutate((rows) => ({
        rows: rows.map((row) => {
          if (row.id !== id) return row;
          const next = { ...row };
          if (updates.label !== undefined) next.label = updates.label;
          if (updates.value !== undefined) next.value = unredact(updates.value);
          return next;
        }),
        result: undefined,
      })),
    remove: (id: ID) =>
      mutate((rows) => ({ rows: rows.filter((row) => row.id !== id), result: undefined })),
    refreshOAuth: (id, now, refresh) =>
      withLock(
        false,
        readRows().pipe(
          Effect.flatMap((loaded) => {
            if (!loaded.valid)
              return Effect.die(new Error("credential store contains invalid JSON"));
            const row = loaded.rows.find((item) => item.id === id);
            if (!row) return Effect.void;
            if (
              row.value.type === "key" ||
              row.value.expires > now + Duration.minutes(5).pipe(Duration.toMillis)
            )
              return Effect.succeed(redact(row.value));
            return refresh(redact(row.value) as OAuth).pipe(
              Effect.flatMap((value) =>
                writeRows(
                  loaded.rows.map((item) =>
                    item.id === id ? { ...item, value: unredact(value) } : item,
                  ),
                ).pipe(Effect.as(value)),
              ),
            );
          }),
        ),
      ),
  } as Interface;
});

export const layer = Layer.effect(Service, implementation);

export const Default = layer.pipe(Layer.provide(Path.layer));
