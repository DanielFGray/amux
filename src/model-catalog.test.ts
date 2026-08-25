import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Stream } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { ModelCatalog } from "./model-catalog.ts";
import { testEffect } from "./test-effect.ts";
import { EventBus } from "./effect/EventBus.ts";

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

async function environment() {
  const home = await mkdtemp(join(tmpdir(), "amux-model-catalog-"));
  return { HOME: home, XDG_STATE_HOME: join(home, "state") };
}

function provide<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  env: NodeJS.ProcessEnv,
  fetch: Effect.Effect<string, never>,
) {
  return effect.pipe(
    Effect.provide(ModelCatalog.testLayer(fetch)),
    Effect.provide(EventBus.Default),
    Effect.provide(BunFileSystem.layer),
    Effect.withConfigProvider(ConfigProvider.fromJson(env)),
  );
}

const cleanup = (env: NodeJS.ProcessEnv) =>
  Effect.addFinalizer(() => Effect.promise(() => rm(env.HOME!, { recursive: true, force: true })));

testEffect("fetches, caches, and lists the catalog", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* cleanup(env);
    let calls = 0;
    const fetch = Effect.sync(() => {
      calls++;
      return JSON.stringify(catalog);
    });
    const providers = yield* provide(
      ModelCatalog.Service.pipe(Effect.flatMap((service) => service.providers())),
      env,
      fetch,
    );
    expect(providers.openai?.models["gpt-test"]?.name).toBe("GPT Test");
    expect(calls).toBe(1);
    const file = join(env.XDG_STATE_HOME!, "amux", "cache", "models.json");
    expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(yield* Effect.promise(() => readFile(file, "utf8"))).openai.id).toBe(
      "openai",
    );
  }),
);

testEffect("shares one fetch between concurrent callers", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* cleanup(env);
    let calls = 0;
    const fetch = Effect.promise(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return JSON.stringify(catalog);
    });
    const result = yield* Effect.all(
      [
        ModelCatalog.Service.pipe(Effect.flatMap((service) => service.providers())),
        ModelCatalog.Service.pipe(Effect.flatMap((service) => service.providers())),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.provide(ModelCatalog.testLayer(fetch)),
      Effect.provide(EventBus.Default),
      Effect.provide(BunFileSystem.layer),
      Effect.withConfigProvider(ConfigProvider.fromJson(env)),
    );
    expect(result).toHaveLength(2);
    expect(calls).toBe(1);
  }),
);

testEffect("falls back to a stale valid cache and skips corrupt rows", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* cleanup(env);
    const directory = join(env.XDG_STATE_HOME!, "amux", "cache");
    yield* Effect.promise(() => mkdir(directory, { recursive: true }));
    const stale = {
      ...catalog,
      broken: { id: "broken", name: 42, env: [], models: {} },
    };
    yield* Effect.promise(() => writeFile(join(directory, "models.json"), JSON.stringify(stale)));
    const providers = yield* provide(
      ModelCatalog.Service.pipe(Effect.flatMap((service) => service.providers())),
      env,
      Effect.succeed("network unavailable"),
    );
    expect(providers.openai?.id).toBe("openai");
    expect(providers.broken).toBeUndefined();
  }),
);

testEffect("forced refresh publishes a refresh event", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* cleanup(env);
    const fetch = Effect.succeed(JSON.stringify(catalog));
    const effect = Effect.gen(function* () {
      const service = yield* ModelCatalog.Service;
      const events = yield* EventBus.pipe(Effect.flatMap((bus) => bus.subscribe()));
      yield* service.refresh(true);
      expect(
        (yield* Stream.runCollect(Stream.take(events, 1))).pipe((chunk) => [...chunk][0]?.event),
      ).toEqual({ _tag: "models.refreshed" });
    });
    yield* provide(effect, env, fetch);
  }),
);
