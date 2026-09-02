import { expect } from "bun:test";
import { Effect, Layer, Option, Result } from "effect";
import { agentPreflight } from "./preflight.ts";
import { testEffect } from "@danielfgray/amux/testing";
import { Service as Integration, type Interface as IntegrationService } from "./integration.ts";
import {
  Service as ModelCatalog,
  type Interface as ModelCatalogService,
  type Model,
} from "./model-catalog.ts";

function fakeIntegrations(has: Record<string, boolean>): IntegrationService {
  const connections = (id: string) =>
    has[id] ? [{ type: "credential" as const, id: `cred-${id}` as never, label: "default" }] : [];
  return {
    get: (id) =>
      Effect.succeed({
        id,
        label: id,
        methods: [{ type: "key" as const }],
        connections: connections(id),
      }),
    list: Effect.succeed([]),
    active: (id) => Effect.succeed(connections(id)[0]),
    resolve: () => Effect.as(Effect.void, undefined),
    model: () => Effect.as(Effect.void, undefined),
  };
}

function fakeModelCatalog(models: Record<string, Model>): ModelCatalogService {
  return {
    providers: Effect.succeed({}),
    provider: () => Effect.as(Effect.void, undefined),
    model: (providerID, modelID) => Effect.succeed(models[`${providerID}/${modelID}`]),
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

/** The whole check, against a provider that is connected or not and a catalog
 *  that lists the model or not. Returns the Result so the caller can inspect it. */
function preflight(
  reference: string,
  options: { connected?: Record<string, boolean>; catalog?: Record<string, Model> } = {},
) {
  return Effect.result(
    agentPreflight(reference).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Integration, fakeIntegrations(options.connected ?? { openai: true })),
          Layer.succeed(
            ModelCatalog,
            fakeModelCatalog(options.catalog ?? { "openai/gpt-4o-mini": sampleModel }),
          ),
        ),
      ),
    ),
  );
}

/** The refusal reason, or None when the reference was wrongly accepted. */
function refusal(reference: string, options?: Parameters<typeof preflight>[1]) {
  return Effect.map(preflight(reference, options), (result) =>
    result._tag === "Failure" ? Option.some(result.failure.message) : Option.none(),
  );
}

testEffect("a connected provider offering the model passes", () =>
  Effect.gen(function* () {
    expect(Result.isSuccess(yield* preflight("openai/gpt-4o-mini"))).toBe(true);
  }),
);

testEffect("an invalid model reference (empty) is refused", () =>
  Effect.gen(function* () {
    expect(yield* refusal("invalid")).toEqual(
      Option.some("invalid agent.model 'invalid', expected provider/model"),
    );
  }),
);

testEffect("a providerless model reference is refused", () =>
  Effect.gen(function* () {
    expect(yield* refusal("openai/")).toEqual(
      Option.some("invalid agent.model 'openai/', expected provider/model"),
    );
  }),
);

testEffect("a bare model reference is refused", () =>
  Effect.gen(function* () {
    expect(yield* refusal("/gpt-4o")).toEqual(
      Option.some("invalid agent.model '/gpt-4o', expected provider/model"),
    );
  }),
);

testEffect("a provider with no stored credential is refused", () =>
  Effect.gen(function* () {
    expect(yield* refusal("openai/gpt-4o-mini", { connected: {} })).toEqual(
      Option.some("no credential stored for openai"),
    );
  }),
);

testEffect("a provider the registry does not know is refused as unconnected", () =>
  Effect.gen(function* () {
    expect(yield* refusal("unknown/gpt-4o-mini", { connected: {} })).toEqual(
      Option.some("no credential stored for unknown"),
    );
  }),
);

testEffect("a model the catalog does not list is refused", () =>
  Effect.gen(function* () {
    expect(yield* refusal("openai/gpt-4o-mini", { catalog: {} })).toEqual(
      Option.some("model openai/gpt-4o-mini is not available"),
    );
  }),
);
