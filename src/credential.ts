import path from "node:path";
import { randomUUID } from "node:crypto";
import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Option, Redacted, Schema as S } from "effect";
import { stateRoot } from "./session.ts";
import { flock, flockUnlock } from "./shim.ts";

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
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface Key {
  readonly type: "key";
  readonly key: Secret;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export type Value = OAuth | Key;

export interface Info {
  readonly id: ID;
  readonly integrationID: string;
  readonly label: string;
  readonly value: Value;
}

export interface Interface {
  readonly all: () => Effect.Effect<Info[]>;
  readonly list: (integrationID: string) => Effect.Effect<Info[]>;
  readonly get: (id: ID) => Effect.Effect<Info | undefined>;
  readonly create: (input: {
    readonly integrationID: string;
    readonly value: Value;
    readonly label?: string;
  }) => Effect.Effect<Info>;
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>;
  readonly remove: (id: ID) => Effect.Effect<void>;
}

export class Service extends Context.Tag("amux/Credential")<Service, Interface>() {}

const PersistedValue = S.Union(
  S.Struct({
    type: S.Literal("key"),
    key: S.String,
    metadata: S.optional(S.Record({ key: S.String, value: S.Unknown })),
  }),
  S.Struct({
    type: S.Literal("oauth"),
    methodID: S.String,
    refresh: S.String,
    access: S.String,
    expires: S.NonNegativeInt,
    metadata: S.optional(S.Record({ key: S.String, value: S.Unknown })),
  }),
);
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

const decodeText = (
  text: string,
): {
  readonly valid: boolean;
  readonly rows: readonly Persisted[];
} => {
  const parsed = S.decodeUnknownOption(S.parseJson(S.Array(S.Unknown)))(text);
  if (Option.isNone(parsed)) return { valid: false, rows: [] };
  return {
    valid: true,
    rows: parsed.value.flatMap((row) => {
      const decoded = S.decodeUnknownOption(PersistedInfo)(row);
      return Option.isSome(decoded) ? [decoded.value] : [];
    }),
  };
};

const paths = (root: string) => {
  const directory = path.join(root, "amux");
  return {
    directory,
    file: path.join(directory, "auth.json"),
    lock: path.join(directory, "auth.json.lock"),
  };
};

const lock = (fd: number, shared: boolean) =>
  Effect.gen(function* () {
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
  const root = yield* stateRoot();
  const target = paths(root);

  const readRows = Effect.fnUntraced(function* () {
    const text = yield* fs
      .readFileString(target.file)
      .pipe(
        Effect.catchTag("SystemError", (error) =>
          error.reason === "NotFound" ? Effect.succeed("[]") : Effect.fail(error),
        ),
      );
    return decodeText(text);
  });

  const withLock = <A>(shared: boolean, body: Effect.Effect<A, any, any>) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(target.directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(target.directory, 0o700);
      return yield* Effect.scoped(
        Effect.acquireUseRelease(
          fs.open(target.lock, { flag: "a+", mode: 0o600 }),
          (handle) =>
            fs
              .chmod(target.lock, 0o600)
              .pipe(
                Effect.zipRight(lock(handle.fd, shared)),
                Effect.zipRight(
                  fs
                    .chmod(target.file, 0o600)
                    .pipe(
                      Effect.catchTag("SystemError", (error) =>
                        error.reason === "NotFound" ? Effect.void : Effect.fail(error),
                      ),
                    ),
                ),
                Effect.zipRight(body),
              ),
          (handle) =>
            Effect.sync(() => {
              flockUnlock(handle.fd);
            }),
        ),
      );
    });

  const writeRows = (rows: readonly Persisted[]) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(target.directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(target.directory, 0o700);
      const temp = `${target.file}.${process.pid}.${randomUUID()}.tmp`;
      const handle = yield* fs.open(temp, { flag: "wx", mode: 0o600 });
      yield* Effect.acquireUseRelease(
        Effect.succeed(handle),
        (file) =>
          file
            .writeAll(new TextEncoder().encode(JSON.stringify(rows) + "\n"))
            .pipe(Effect.zipRight(file.sync)),
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
    all: () => read((rows) => rows.map(present)),
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
        rows: rows.map((row) =>
          row.id === id
            ? {
                ...row,
                ...(updates.label === undefined ? {} : { label: updates.label }),
                ...(updates.value === undefined ? {} : { value: unredact(updates.value) }),
              }
            : row,
        ),
        result: undefined,
      })),
    remove: (id: ID) =>
      mutate((rows) => ({ rows: rows.filter((row) => row.id !== id), result: undefined })),
  } as Interface;
});

export const layer = Layer.effect(Service, implementation);

export const Default = layer;
