import { expect, test } from "bun:test";
import { Effect, Either, Layer } from "effect";
import { agentPreflight } from "./preflight.ts";
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
    list: () => Effect.succeed([]),
    active: (id) => Effect.succeed(connections(id)[0]),
    resolve: () => Effect.as(Effect.void, undefined),
    model: () => Effect.as(Effect.void, undefined),
  };
}

function fakeModelCatalog(models: Record<string, Model>): ModelCatalogService {
  return {
    providers: () => Effect.succeed({}),
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
 *  that lists the model or not. */
function preflight(
  reference: string,
  options: { connected?: Record<string, boolean>; catalog?: Record<string, Model> } = {},
) {
  return Effect.runPromise(
    Effect.either(
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
    ),
  );
}

async function refusal(reference: string, options?: Parameters<typeof preflight>[1]) {
  const result = await preflight(reference, options);
  if (Either.isRight(result)) throw new Error(`expected '${reference}' to be refused`);
  return result.left.message;
}

test("a connected provider offering the model passes", async () => {
  expect(Either.isRight(await preflight("openai/gpt-4o-mini"))).toBe(true);
});

test.each([["invalid"], ["openai/"], ["/gpt-4o"]])(
  "a model reference that is not provider/model is refused: %p",
  async (reference) => {
    expect(await refusal(reference)).toBe(
      `invalid agent.model '${reference}', expected provider/model`,
    );
  },
);

test("a provider with no stored credential is refused", async () => {
  expect(await refusal("openai/gpt-4o-mini", { connected: {} })).toBe(
    "no credential stored for openai",
  );
});

test("a provider the registry does not know is refused as unconnected", async () => {
  expect(await refusal("unknown/gpt-4o-mini", { connected: {} })).toBe(
    "no credential stored for unknown",
  );
});

test("a model the catalog does not list is refused", async () => {
  expect(await refusal("openai/gpt-4o-mini", { catalog: {} })).toBe(
    "model openai/gpt-4o-mini is not available",
  );
});
