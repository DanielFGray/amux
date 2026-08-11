import { expect, test } from "bun:test";
import { Effect, Either } from "effect";
import { agentPreflight } from "./agent-preflight.ts";
import type { Interface as IntegrationService } from "./integration.ts";
import type { Interface as ModelCatalogService } from "./model-catalog.ts";
import type { Model } from "./model-catalog.ts";

function fakeIntegrations(has: Record<string, boolean>): IntegrationService {
  return {
    get: (id) =>
      Effect.succeed(
        has[id]
          ? {
              id,
              label: id,
              methods: [{ type: "key" as const }],
              connections: [
                { type: "credential" as const, id: `cred-${id}` as never, label: "default" },
              ],
            }
          : { id, label: id, methods: [{ type: "key" as const }], connections: [] },
      ),
    list: () => Effect.succeed([]),
    active: (id) =>
      Effect.succeed(
        has[id]
          ? { type: "credential" as const, id: `cred-${id}` as never, label: "default" }
          : undefined,
      ),
    resolve: () => Effect.void.pipe(Effect.as(undefined)),
    model: () => Effect.void.pipe(Effect.as(undefined)),
  };
}

function fakeModelCatalog(models: Record<string, Model | undefined>): ModelCatalogService {
  const index: Record<string, Record<string, Model | undefined>> = {};
  for (const [key, model] of Object.entries(models)) {
    const [providerID, modelID] = key.split("/");
    (index[providerID!] ??= {})[modelID!] = model;
  }
  return {
    providers: () => Effect.succeed({}),
    provider: () => Effect.void.pipe(Effect.as(undefined)),
    model: (providerID, modelID) => Effect.succeed(index[providerID]?.[modelID]),
    refresh: () => Effect.void,
    invalidate: Effect.void,
  };
}

const sampleModel: Model = {
  id: "gpt-4o-mini",
  name: "GPT-4o Mini",
  release_date: "2024-07-18",
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  limit: { context: 128_000, output: 16_384 },
};

test("valid model reference with no integrations passes", async () => {
  await Effect.runPromise(agentPreflight("openai/gpt-4o-mini"));
});

test("invalid model reference (no slash) fails", async () => {
  const result = await Effect.runPromise(Effect.either(agentPreflight("invalid")));
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toEqual({ _tag: "InvalidModel", value: "invalid" });
  }
});

test("invalid model reference (empty model) fails", async () => {
  const result = await Effect.runPromise(Effect.either(agentPreflight("openai/")));
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toEqual({ _tag: "InvalidModel", value: "openai/" });
  }
});

test("invalid model reference (empty provider) fails", async () => {
  const result = await Effect.runPromise(Effect.either(agentPreflight("/gpt-4o")));
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toEqual({ _tag: "InvalidModel", value: "/gpt-4o" });
  }
});

test("no credential for provider fails", async () => {
  const integrations = fakeIntegrations({});
  const result = await Effect.runPromise(
    Effect.either(agentPreflight("openai/gpt-4o-mini", integrations)),
  );
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toEqual({ _tag: "NoCredential", providerID: "openai" });
  }
});

test("credential exists passes credential check", async () => {
  const integrations = fakeIntegrations({ openai: true });
  await Effect.runPromise(agentPreflight("openai/gpt-4o-mini", integrations));
});

test("model available in catalog passes catalog check", async () => {
  const integrations = fakeIntegrations({ openai: true });
  const catalog = fakeModelCatalog({ "openai/gpt-4o-mini": sampleModel });
  await Effect.runPromise(agentPreflight("openai/gpt-4o-mini", integrations, catalog));
});

test("model not in catalog fails catalog check", async () => {
  const integrations = fakeIntegrations({ openai: true });
  const catalog = fakeModelCatalog({});
  const result = await Effect.runPromise(
    Effect.either(agentPreflight("openai/gpt-4o-mini", integrations, catalog)),
  );
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toEqual({
      _tag: "ModelUnavailable",
      providerID: "openai",
      modelID: "gpt-4o-mini",
    });
  }
});

test("missing integration is treated as no credential", async () => {
  const integrations = fakeIntegrations({});
  const result = await Effect.runPromise(
    Effect.either(agentPreflight("unknown/gpt-4o-mini", integrations)),
  );
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toEqual({ _tag: "NoCredential", providerID: "unknown" });
  }
});
