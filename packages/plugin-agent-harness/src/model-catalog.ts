import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Clock, Context, Duration, Effect, Layer, Option, Schedule, Schema as S } from "effect";
import { stateRoot } from "@danielfgray/amux/session.ts";
import { EventBus } from "@danielfgray/amux/effect/EventBus.ts";

export * as ModelCatalog from "./model-catalog.ts";

export const CatalogModelStatus = S.Union([
  S.Literals(["alpha"]),
  S.Literals(["beta"]),
  S.Literals(["deprecated"]),
]);
export type CatalogModelStatus = typeof CatalogModelStatus.Type;

const Cost = S.Struct({
  input: S.Finite,
  output: S.Finite,
  cache_read: S.optional(S.Finite),
  cache_write: S.optional(S.Finite),
});

export const Model = S.Struct({
  id: S.String,
  name: S.String,
  family: S.optional(S.String),
  release_date: S.String,
  attachment: S.Boolean,
  reasoning: S.Boolean,
  temperature: S.Boolean,
  tool_call: S.Boolean,
  cost: S.optional(Cost),
  limit: S.Struct({ context: S.Finite, input: S.optional(S.Finite), output: S.Finite }),
  modalities: S.optional(S.Struct({ input: S.Array(S.String), output: S.Array(S.String) })),
  status: S.optional(CatalogModelStatus),
  provider: S.optional(S.Struct({ npm: S.optional(S.String), api: S.optional(S.String) })),
});
export type Model = S.Schema.Type<typeof Model>;

export const Provider = S.Struct({
  api: S.optional(S.String),
  name: S.String,
  env: S.Array(S.String),
  id: S.String,
  npm: S.optional(S.String),
  models: S.Record(S.String, Model),
});
export type Provider = S.Schema.Type<typeof Provider>;

interface CatalogFetcher {
  readonly fetch: Effect.Effect<string, never>;
}

class Fetcher extends Context.Service<Fetcher, CatalogFetcher>()("amux/ModelCatalogFetcher") {}

export interface Interface {
  readonly providers: Effect.Effect<Readonly<Record<string, Provider>>>;
  readonly provider: (id: string) => Effect.Effect<Provider | undefined>;
  readonly model: (providerID: string, modelID: string) => Effect.Effect<Model | undefined>;
  readonly refresh: (force?: boolean) => Effect.Effect<void>;
  readonly invalidate: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("amux/ModelCatalog") {}

const CACHE_TTL = Duration.minutes(5);
const SOURCE = "https://models.opencode.ai/api.json";
const RawCatalog = S.fromJsonString(S.Record(S.String, S.Unknown));

const httpFetcher = Layer.effect(
  Fetcher,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.get(SOURCE).pipe(
      HttpClientRequest.setHeader("User-Agent", "amux/model-catalog"),
      http.execute,
      Effect.flatMap((response) => response.text),
      Effect.timeout("10 seconds"),
      Effect.retry({ times: 2, schedule: Schedule.exponential("200 millis") }),
      Effect.orDie,
    );
    return { fetch: Effect.succeed(response) } satisfies CatalogFetcher;
  }),
);

export const makeLayer = (fetcher: Layer.Layer<Fetcher, never, never>) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const events = yield* EventBus;
      const source = yield* Fetcher;
      const root = yield* stateRoot();
      const path = yield* Path.Path;
      const directory = path.join(root, "amux", "cache");
      const file = path.join(directory, "models.json");

      const decode = (text: string): Readonly<Record<string, Provider>> | undefined => {
        const raw = S.decodeOption(RawCatalog)(text);
        if (Option.isNone(raw)) return undefined;
        const providers: Record<string, Provider> = {};
        for (const [id, value] of Object.entries(raw.value)) {
          const provider = S.decodeUnknownOption(Provider)(value);
          if (Option.isSome(provider)) providers[id] = provider.value;
        }
        return providers;
      };
      const readDisk = Effect.gen(function* () {
        const text = yield* fs
          .readFileString(file)
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound"
                ? Effect.void.pipe(Effect.as(undefined))
                : Effect.fail(error),
            ),
          );
        if (text === undefined) return undefined;
        const value = decode(text);
        return value;
      });
      const fresh = Effect.gen(function* () {
        const info = yield* fs.stat(file).pipe(Effect.catchTag("PlatformError", () => Effect.void));
        if (info === undefined || Option.isNone(info.mtime)) return false;
        const now = yield* Clock.currentTimeMillis;
        return now - info.mtime.value.getTime() < Duration.toMillis(CACHE_TTL);
      });
      const writeDisk = (value: Readonly<Record<string, Provider>>) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
            yield* fs.chmod(directory, 0o700);
            const now = yield* Clock.currentTimeMillis;
            const temp = `${file}.${process.pid}.${now}.tmp`;
            const handle = yield* fs.open(temp, { flag: "wx", mode: 0o600 });
            const encoded = yield* S.encodeEffect(S.fromJsonString(S.Record(S.String, S.Unknown)))(
              value,
            );
            yield* handle.writeAll(new TextEncoder().encode(encoded + "\n"));
            yield* handle.sync;
            yield* fs.chmod(temp, 0o600);
            yield* fs.rename(temp, file);
            const directoryHandle = yield* fs.open(directory, { flag: "r" });
            yield* directoryHandle.sync;
          }),
        );
      const populate = Effect.gen(function* () {
        const disk = yield* readDisk.pipe(Effect.orDie);
        if (disk && (yield* fresh.pipe(Effect.orDie))) return disk;
        const downloaded = yield* source.fetch.pipe(
          Effect.flatMap((text) => {
            const value = decode(text);
            return value === undefined ? Effect.fail("invalid catalog") : Effect.succeed(value);
          }),
          Effect.catch(() =>
            disk ? Effect.succeed(disk) : Effect.succeed({} as Readonly<Record<string, Provider>>),
          ),
        );
        if (downloaded !== disk) yield* writeDisk(downloaded).pipe(Effect.orDie);
        return downloaded;
      });
      const [get, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity);
      const safeGet = get.pipe(Effect.orDie);

      return {
        providers: safeGet,
        provider: (id) => safeGet.pipe(Effect.map((providers) => providers[id])),
        model: (providerID, modelID) =>
          safeGet.pipe(Effect.map((providers) => providers[providerID]?.models[modelID])),
        refresh: (force = false) =>
          Effect.gen(function* () {
            if (!force && (yield* fresh.pipe(Effect.orDie))) return;
            yield* source.fetch.pipe(
              Effect.flatMap((text) => {
                const value = decode(text);
                return value === undefined ? Effect.fail("invalid catalog") : Effect.succeed(value);
              }),
              Effect.tap((value) => writeDisk(value).pipe(Effect.orDie)),
              Effect.tap(() => invalidate),
              Effect.tap(() => events.publish({ _tag: "models.refreshed" })),
              Effect.ignore,
            );
          }),
        invalidate: invalidate.pipe(Effect.orDie),
      } satisfies Interface;
    }),
  ).pipe(Layer.provide(fetcher), Layer.provide(Path.layer));

export const layer = makeLayer(httpFetcher.pipe(Layer.provide(FetchHttpClient.layer))).pipe(
  Layer.provide(EventBus.layer),
);
export const Default = layer;

export const testLayer = (fetch: Effect.Effect<string, never>) =>
  makeLayer(Layer.succeed(Fetcher, { fetch }));
