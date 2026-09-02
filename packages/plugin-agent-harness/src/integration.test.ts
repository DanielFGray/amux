import { expect } from "bun:test";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Clock, ConfigProvider, Effect, Layer, Redacted, Schema as S } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { BunFileSystem } from "@effect/platform-bun";
import { Credential } from "./credential.ts";
import { ModelCatalog } from "./model-catalog.ts";
import { EventBus } from "@danielfgray/amux/effect/EventBus.ts";
import { makeLayer, Service, type Integration } from "./integration.ts";
import { openAiCompatible, type ModelRequest } from "./integration/index.ts";
import { testEffect } from "@danielfgray/amux/testing";

class NoModelLayer extends S.TaggedError<NoModelLayer>()("NoModelLayer", {}) {}

const withFileServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, Path.layer)));

const environment = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "amux-integration-" });
  return {
    fs,
    variables: { HOME: root, XDG_STATE_HOME: path.join(root, "state") },
  };
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, variables: NodeJS.ProcessEnv) =>
  effect.pipe(
    Effect.provide(
      makeLayer().pipe(
        Layer.provideMerge(Credential.Default),
        Layer.provideMerge(BunFileSystem.layer),
        Layer.provideMerge(
          Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(variables)),
        ),
      ),
    ),
  );

const key = (value: string) => ({
  type: "key" as const,
  key: Redacted.make(value),
});

testEffect("stored credentials are the active connection", () =>
  Effect.gen(function* () {
    const { fs, variables } = yield* environment;
    const root = variables.HOME!;
    yield* Effect.addFinalizer(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore));
    const created = yield* run(
      Credential.Service.pipe(
        Effect.flatMap((store) =>
          store.create({
            integrationID: "openai",
            value: key("stored"),
            label: "stored",
          }),
        ),
      ),
      variables,
    );
    const active = yield* run(
      Service.pipe(Effect.flatMap((integration) => integration.active("openai"))),
      variables,
    );
    expect(active).toEqual({
      type: "credential",
      id: created.id,
      label: "stored",
    });
    const value = yield* run(
      Service.pipe(Effect.flatMap((integration) => integration.resolve(active!))),
      variables,
    );
    expect(value && value.type === "key" ? Redacted.value(value.key) : undefined).toBe("stored");
  }).pipe(withFileServices),
);

testEffect("an integration is told the API host the catalog names for it", () =>
  Effect.gen(function* () {
    const { fs, variables } = yield* environment;
    const root = variables.HOME!;
    yield* Effect.addFinalizer(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore));
    // Two providers: one the catalog gives a host, one it does not. An
    // OpenAI-compatible provider is nothing but its host, and a first-party one
    // must not have its SDK's own default overwritten with an absent value.
    const catalog = {
      "opencode-go": {
        id: "opencode-go",
        name: "OpenCode Go",
        env: [],
        api: "https://opencode.ai/zen/go/v1",
        models: {},
      },
      anthropic: { id: "anthropic", name: "Anthropic", env: [], models: {} },
    };
    const asked: ModelRequest[] = [];
    const spy = (id: string): Integration => ({
      id,
      label: id,
      methods: [{ type: "key", label: "API key" }],
      env: [],
      model: (request) => {
        asked.push(request);
        return Layer.empty as never;
      },
      authorize: (_credential, request) => request,
    });
    const registry = makeLayer(
      [spy("opencode-go"), spy("anthropic")],
      ModelCatalog.testLayer(
        S.encodeEffect(S.fromJsonString(S.Unknown))(catalog).pipe(Effect.orDie),
      ).pipe(Layer.provide(EventBus.layer)),
    );
    const build = (id: string, model: string) =>
      Service.pipe(
        Effect.flatMap((integration) => integration.model(id, model)),
        Effect.provide(
          registry.pipe(
            Layer.provide(Credential.Default),
            Layer.provide(BunFileSystem.layer),
            Layer.provide(
              Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(variables)),
            ),
          ),
        ),
      );

    yield* build("opencode-go", "glm-5");
    yield* build("anthropic", "claude-opus-4-5");

    expect(asked.map((request) => [request.model, request.apiUrl])).toEqual([
      ["glm-5", "https://opencode.ai/zen/go/v1"],
      // Undefined rather than absent-and-defaulted-to-something: the client's
      // own host is right for a provider the catalog names none for.
      ["claude-opus-4-5", undefined],
    ]);
  }).pipe(withFileServices),
);

testEffect("refreshes OAuth credentials at the five-minute boundary", () =>
  Effect.gen(function* () {
    const { fs, variables } = yield* environment;
    const root = variables.HOME!;
    yield* Effect.addFinalizer(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore));
    let refreshed = 0;
    const definition: Integration = {
      id: "fake",
      label: "Fake",
      methods: [{ type: "oauth", id: "fake-oauth", label: "Fake OAuth" }],
      env: [],
      refresh: (credential) =>
        Effect.sync(() => {
          refreshed++;
          return {
            ...credential,
            access: Redacted.make("new-access"),
            expires: credential.expires + 60_000,
          };
        }),
      model: () => Effect.die("unused") as never,
      authorize: (credential, request) => request,
    };
    const now = yield* Clock.currentTimeMillis;
    const created = yield* run(
      Credential.Service.pipe(
        Effect.flatMap((store) =>
          store.create({
            integrationID: "fake",
            value: {
              type: "oauth",
              methodID: "fake-oauth",
              access: Redacted.make("old-access"),
              refresh: Redacted.make("refresh"),
              expires: now + 300_000,
            },
            label: "fake",
          }),
        ),
      ),
      variables,
    );
    const registry = makeLayer([definition]);
    const runRegistry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(
          registry.pipe(
            Layer.provide(Credential.Default),
            Layer.provide(BunFileSystem.layer),
            Layer.provide(
              Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(variables)),
            ),
          ),
        ),
      );
    const connection = {
      type: "credential" as const,
      id: created.id,
      label: "fake",
    };
    yield* runRegistry(
      Service.pipe(Effect.flatMap((integration) => integration.resolve(connection))),
    );
    expect(refreshed).toBe(1);
    yield* runRegistry(
      Service.pipe(Effect.flatMap((integration) => integration.resolve(connection))),
    );
    expect(refreshed).toBe(1);
  }).pipe(withFileServices),
);

// =============================================================================
// The installed-adapter path: a model built through the registry stamps a fresh
// Authorization header per request, and a token that expires mid-session is
// refreshed on the next request without a worker restart.
// =============================================================================

/** A real gateway that records the Authorization header of every request. */
const gateway = () => {
  const authorization: Array<string | undefined> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      authorization.push(request.headers.get("authorization") ?? undefined);
      const body =
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    port: server.port,
    authorization,
    stop: () => server.stop(),
  };
};

const adapter = (refresh?: Integration["refresh"]): Integration => ({
  ...openAiCompatible({ id: "fake", label: "Fake", env: "FAKE_API_KEY" }),
  refresh,
});

const catalogLayer = (apiUrl: string) =>
  ModelCatalog.testLayer(
    Effect.succeed(
      JSON.stringify({
        fake: { id: "fake", name: "Fake", env: [], api: apiUrl, models: {} },
      }),
    ),
  ).pipe(Layer.provide(EventBus.layer));

/** The registry for the fake integration, over one catalog. */
const registry = (apiUrl: string, refresh?: Integration["refresh"]) =>
  makeLayer([adapter(refresh)], catalogLayer(apiUrl));

/** Build the fake integration's LanguageModel layer through the registry. */
const buildModelLayer = (apiUrl: string, refresh?: Integration["refresh"]) =>
  Service.pipe(
    Effect.flatMap((integration) => integration.model("fake", "m")),
    Effect.flatMap((layer) => (layer ? Effect.succeed(layer) : Effect.fail(new NoModelLayer()))),
    Effect.provide(registry(apiUrl, refresh)),
  );

/** One turn against the fake integration's model. */
const generate = (modelLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel;
    return yield* model.generateText({ prompt: "hello" });
  }).pipe(Effect.provide(modelLayer));

/** Provide the store, filesystem and config an effect reads the credential from. */
const adapterLayers =
  (variables: NodeJS.ProcessEnv) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        Credential.Default.pipe(
          Layer.provideMerge(BunFileSystem.layer),
          Layer.provideMerge(
            Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(variables)),
          ),
        ),
      ),
    );

testEffect("a model built from the registry stamps its credential on every request", () =>
  Effect.gen(function* () {
    const { fs, variables } = yield* environment;
    const root = variables.HOME!;
    yield* Effect.addFinalizer(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore));
    const layers = adapterLayers(variables);
    const gw = gateway();
    yield* Effect.addFinalizer(() => Effect.promise(() => gw.stop()));
    yield* layers(
      Credential.Service.pipe(
        Effect.flatMap((store) =>
          store.create({ integrationID: "fake", value: key("stored-key"), label: "stored" }),
        ),
      ),
    );
    const modelLayer = yield* buildModelLayer(`http://127.0.0.1:${gw.port}/v1`).pipe(layers);
    yield* generate(modelLayer).pipe(layers);
    // The request actually reached a gateway, and it carried the stored key.
    expect(gw.authorization).toEqual(["Bearer stored-key"]);
  }).pipe(withFileServices),
);

testEffect("a token expiring mid-session is refreshed on the next request", () =>
  Effect.gen(function* () {
    const { fs, variables } = yield* environment;
    const root = variables.HOME!;
    yield* Effect.addFinalizer(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore));
    const layers = adapterLayers(variables);
    const gw = gateway();
    yield* Effect.addFinalizer(() => Effect.promise(() => gw.stop()));
    const freshExpiry = yield* Clock.currentTimeMillis;
    const created = yield* layers(
      Credential.Service.pipe(
        Effect.flatMap((store) =>
          store.create({
            integrationID: "fake",
            value: {
              type: "oauth",
              methodID: "fake-oauth",
              access: Redacted.make("old-access"),
              refresh: Redacted.make("refresh"),
              expires: freshExpiry + 10 * 60_000,
            },
            label: "fake",
          }),
        ),
      ),
    );
    // One model instance, two requests. Between them the stored token's expiry
    // passes, exactly as it would mid-session: the second request must carry a
    // fresh token resolved from the store, with no worker restart involved.
    const modelLayer = yield* buildModelLayer(
      `http://127.0.0.1:${gw.port}/v1`,
      credentialRefresh,
    ).pipe(layers);
    yield* generate(modelLayer).pipe(layers);
    const expiredAt = yield* Clock.currentTimeMillis;
    yield* layers(
      Credential.Service.pipe(
        Effect.flatMap((store) =>
          store.update(created.id, {
            value: {
              type: "oauth",
              methodID: "fake-oauth",
              access: Redacted.make("old-access"),
              refresh: Redacted.make("refresh"),
              expires: expiredAt - 1,
            },
          }),
        ),
      ),
    );
    yield* generate(modelLayer).pipe(layers);
    expect(gw.authorization).toEqual(["Bearer old-access", "Bearer new-access"]);
  }).pipe(withFileServices),
);

const credentialRefresh: Integration["refresh"] = (credential) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => ({
      ...credential,
      access: Redacted.make("new-access"),
      expires: now + 10 * 60_000,
    })),
  );
