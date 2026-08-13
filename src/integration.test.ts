import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Layer, Redacted, TestClock } from "effect";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Credential } from "./credential.ts";
import { ModelCatalog } from "./model-catalog.ts";
import { EventBus } from "./effect/EventBus.ts";
import { makeLayer, Service, type Integration } from "./integration.ts";
import type { ModelRequest } from "./auth/integration/index.ts";
import { testEffect } from "./test-effect.ts";

const env = (root: string): NodeJS.ProcessEnv => ({
  HOME: root,
  XDG_STATE_HOME: join(root, "state"),
});

const run = <A>(effect: Effect.Effect<A, any, any>, variables: NodeJS.ProcessEnv) =>
  effect.pipe(
    Effect.provide(makeLayer()),
    Effect.provide(Credential.Default),
    Effect.provide(BunFileSystem.layer),
    Effect.withConfigProvider(ConfigProvider.fromJson(variables)),
  ) as Effect.Effect<A, any, never>;

const key = (value: string) => ({
  type: "key" as const,
  key: Redacted.make(value),
});

testEffect("stored credentials are the active connection", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-integration-")));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(root, { recursive: true, force: true })),
    );
    const variables = env(root);
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
  }),
);

testEffect("an integration is told the API host the catalog names for it", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-integration-")));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(root, { recursive: true, force: true })),
    );
    const variables = env(root);
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
      model: (request) => {
        asked.push(request);
        return Layer.empty as never;
      },
      authorize: (_credential, request) => request,
    });
    const registry = makeLayer(
      [spy("opencode-go"), spy("anthropic")],
      ModelCatalog.testLayer(Effect.succeed(JSON.stringify(catalog))).pipe(
        Layer.provide(EventBus.Default),
      ),
    );
    const build = (id: string, model: string) =>
      Service.pipe(
        Effect.flatMap((integration) => integration.model(id, model)),
        Effect.provide(registry),
        Effect.provide(Credential.Default),
        Effect.provide(BunFileSystem.layer),
        Effect.withConfigProvider(ConfigProvider.fromJson(variables)),
      ) as Effect.Effect<unknown, any, never>;

    yield* build("opencode-go", "glm-5");
    yield* build("anthropic", "claude-opus-4-5");

    expect(asked.map((request) => [request.model, request.apiUrl])).toEqual([
      ["glm-5", "https://opencode.ai/zen/go/v1"],
      // Undefined rather than absent-and-defaulted-to-something: the client's
      // own host is right for a provider the catalog names none for.
      ["claude-opus-4-5", undefined],
    ]);
  }),
);

testEffect("refreshes OAuth credentials at the five-minute boundary", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-integration-")));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(root, { recursive: true, force: true })),
    );
    let refreshed = 0;
    const definition: Integration = {
      id: "fake",
      label: "Fake",
      methods: [{ type: "oauth", id: "fake-oauth", label: "Fake OAuth" }],
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
    const variables = env(root);
    const now = Date.now();
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
    const runRegistry = <A>(effect: Effect.Effect<A, any, any>) =>
      effect.pipe(
        Effect.provide(registry),
        Effect.provide(Credential.Default),
        Effect.provide(BunFileSystem.layer),
        Effect.withConfigProvider(ConfigProvider.fromJson(variables)),
      ) as Effect.Effect<A, any, never>;
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
  }),
);
