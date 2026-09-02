import { expect } from "bun:test";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ConfigProvider, Effect, Layer, Stream } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { ModelCatalog } from "./model-catalog.ts";
import { testEffect } from "@danielfgray/amux/testing";
import { EventBus } from "@danielfgray/amux/effect/EventBus.ts";

const catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    env: [],
    models: {
      "gpt-test": {
        id: "gpt-test",
        name: "GPT Test",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 1000, output: 500 },
      },
    },
  },
};
const catalogJson = JSON.stringify(catalog);
const staleJson = JSON.stringify({
  ...catalog,
  broken: { id: "broken", name: 42, env: [], models: {} },
});
const it = testEffect(Layer.mergeAll(BunFileSystem.layer, Path.layer));

const environment = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectory({ prefix: "amux-model-catalog-" });
  return {
    fs,
    path,
    env: { HOME: home, XDG_STATE_HOME: path.join(home, "state") },
  };
});

function provide<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  env: NodeJS.ProcessEnv,
  fetch: Effect.Effect<string, never>,
) {
  return effect.pipe(
    Effect.provide(
      ModelCatalog.testLayer(fetch).pipe(
        Layer.provideMerge(EventBus.layer),
        Layer.provide(BunFileSystem.layer),
        Layer.provide(
          Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
        ),
      ),
    ),
  );
}

const cleanup = (fs: FileSystem.FileSystem, env: NodeJS.ProcessEnv) =>
  Effect.addFinalizer(() =>
    fs.remove(env.HOME!, { recursive: true, force: true }).pipe(Effect.ignore),
  );

it.effect("fetches, caches, and lists the catalog", () =>
  Effect.gen(function* () {
    const { fs, path, env } = yield* environment;
    yield* cleanup(fs, env);
    let calls = 0;
    const fetch = Effect.sync(() => {
      calls++;
      return catalogJson;
    });
    const providers = yield* provide(
      ModelCatalog.Service.pipe(Effect.flatMap((service) => service.providers)),
      env,
      fetch,
    );
    expect(providers.openai?.models["gpt-test"]?.name).toBe("GPT Test");
    expect(calls).toBe(1);
    const file = path.join(env.XDG_STATE_HOME!, "amux", "cache", "models.json");
    expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(yield* fs.readFileString(file)).toContain('"openai"');
  }),
);

it.live("shares one fetch between concurrent callers", () =>
  Effect.gen(function* () {
    const { fs, env } = yield* environment;
    yield* cleanup(fs, env);
    let calls = 0;
    const fetch = Effect.gen(function* () {
      calls++;
      yield* Effect.sleep("20 millis");
      return catalogJson;
    });
    const result = yield* provide(
      Effect.all(
        [
          ModelCatalog.Service.pipe(Effect.flatMap((service) => service.providers)),
          ModelCatalog.Service.pipe(Effect.flatMap((service) => service.providers)),
        ],
        { concurrency: "unbounded" },
      ),
      env,
      fetch,
    );
    expect(result).toHaveLength(2);
    expect(calls).toBe(1);
  }),
);

it.effect("falls back to a stale valid cache and skips corrupt rows", () =>
  Effect.gen(function* () {
    const { fs, path, env } = yield* environment;
    yield* cleanup(fs, env);
    const directory = path.join(env.XDG_STATE_HOME!, "amux", "cache");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(path.join(directory, "models.json"), staleJson);
    const providers = yield* provide(
      ModelCatalog.Service.pipe(Effect.flatMap((service) => service.providers)),
      env,
      Effect.succeed("network unavailable"),
    );
    expect(providers.openai?.id).toBe("openai");
    expect(providers.broken).toBeUndefined();
  }),
);

it.effect("forced refresh publishes a refresh event", () =>
  Effect.gen(function* () {
    const { fs, env } = yield* environment;
    yield* cleanup(fs, env);
    const fetch = Effect.succeed(catalogJson);
    const effect = Effect.gen(function* () {
      const service = yield* ModelCatalog.Service;
      const events = yield* EventBus.pipe(Effect.flatMap((bus) => bus.subscribe));
      yield* service.refresh(true);
      expect((yield* Stream.runCollect(Stream.take(events, 1)))[0]?.event).toEqual({
        _tag: "models.refreshed",
      });
    });
    yield* provide(effect, env, fetch);
  }),
);
