import { expect, test } from "bun:test";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ConfigProvider, Effect, Layer, Option, Schema as S, Stream } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import {
  availableThinkingLevels,
  clampThinkingBudget,
  clampThinkingLevel,
  Model,
  ModelCatalog,
  type Model as ModelRow,
} from "./model-catalog.ts";
import { testEffect } from "@danielfgray/amux/testing";
import { EventBus } from "@danielfgray/amux/effect/EventBus.ts";

const baseModel = {
  id: "gpt-test",
  name: "GPT Test",
  release_date: "2026-01-01",
  attachment: false,
  reasoning: true,
  temperature: true,
  tool_call: true,
  limit: { context: 1000, output: 500 },
} as const;

const decodeModel = (raw: typeof Model.Encoded) => Option.getOrThrow(S.decodeOption(Model)(raw));

test("availableThinkingLevels prefers catalog effort values in order", () => {
  const model = decodeModel({
    ...baseModel,
    reasoning_options: [
      { type: "effort", values: ["minimal", "low", "medium", "high"] },
      { type: "budget_tokens", min: 1024 },
    ],
  });
  expect(availableThinkingLevels(model)).toEqual(["minimal", "low", "medium", "high"]);
});

test("availableThinkingLevels keeps none/off when the catalog lists them", () => {
  const model = decodeModel({
    ...baseModel,
    reasoning_options: [{ type: "effort", values: ["none", "high", "max"] }],
  });
  expect(availableThinkingLevels(model)).toEqual(["none", "high", "max"]);
});

test("availableThinkingLevels maps toggle-only to off/on", () => {
  const model = decodeModel({
    ...baseModel,
    reasoning_options: [{ type: "toggle" }, { type: "budget_tokens" }],
  });
  expect(availableThinkingLevels(model)).toEqual(["off", "on"]);
});

test("availableThinkingLevels is undefined without controllable effort", () => {
  expect(availableThinkingLevels(decodeModel({ ...baseModel, reasoning: false }))).toBeUndefined();
  expect(
    availableThinkingLevels(
      decodeModel({ ...baseModel, reasoning_options: [{ type: "budget_tokens", min: 1024 }] }),
    ),
  ).toBeUndefined();
  expect(
    availableThinkingLevels(decodeModel({ ...baseModel, reasoning_options: [] })),
  ).toBeUndefined();
});

test("unknown reasoning_options variants do not drop the model", () => {
  const model = Option.getOrThrow(
    S.decodeOption(S.fromJsonString(Model))(
      '{"id":"gpt-test","name":"GPT Test","release_date":"2026-01-01","attachment":false,"reasoning":true,"temperature":true,"tool_call":true,"limit":{"context":1000,"output":500},"reasoning_options":[{"type":"future_knob","magnitude":3},{"type":"effort","values":["low","high"]},{"type":"toggle"}]}',
    ),
  );
  expect(model.reasoning_options).toEqual([
    { type: "effort", values: ["low", "high"] },
    { type: "toggle" },
  ]);
  expect(availableThinkingLevels(model)).toEqual(["low", "high"]);
});

test("clampThinkingLevel snaps unknown levels and treats empty as provider default", () => {
  const model = decodeModel({
    ...baseModel,
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  }) satisfies ModelRow;
  expect(clampThinkingLevel(model, "")).toBeUndefined();
  expect(clampThinkingLevel(model, "high")).toBe("high");
  expect(clampThinkingLevel(model, "medium")).toBe("low");
  expect(
    clampThinkingLevel(decodeModel({ ...baseModel, reasoning: false }), "high"),
  ).toBeUndefined();
});

test("clampThinkingBudget omits when absent or zero and clamps to catalog min/max", () => {
  const withBudget = decodeModel({
    ...baseModel,
    reasoning_options: [{ type: "budget_tokens", min: 1024, max: 81920 }],
  });
  expect(clampThinkingBudget(withBudget, 0)).toBeUndefined();
  expect(clampThinkingBudget(withBudget, -1)).toBeUndefined();
  expect(clampThinkingBudget(withBudget, 512)).toBe(1024);
  expect(clampThinkingBudget(withBudget, 4096)).toBe(4096);
  expect(clampThinkingBudget(withBudget, 100_000)).toBe(81920);
  expect(
    clampThinkingBudget(
      decodeModel({ ...baseModel, reasoning_options: [{ type: "effort", values: ["high"] }] }),
      4096,
    ),
  ).toBeUndefined();
  expect(
    clampThinkingBudget(
      decodeModel({
        ...baseModel,
        reasoning: false,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      }),
      4096,
    ),
  ).toBeUndefined();
});

test("budget_tokens max is decoded from the catalog", () => {
  const model = decodeModel({
    ...baseModel,
    reasoning_options: [{ type: "budget_tokens", min: 1024, max: 81920 }],
  });
  expect(model.reasoning_options).toEqual([{ type: "budget_tokens", min: 1024, max: 81920 }]);
});

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
