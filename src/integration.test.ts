import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Redacted, TestClock } from "effect";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Credential } from "./credential.ts";
import { makeLayer, Service, type Integration } from "./integration.ts";
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

const key = (value: string) => ({ type: "key" as const, key: Redacted.make(value) });

testEffect("stored credentials take precedence over environment credentials", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "amux-integration-")));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(root, { recursive: true, force: true })),
    );
    const variables = { ...env(root), OPENAI_API_KEY: "environment" };
    const created = yield* run(
      Credential.Service.pipe(
        Effect.flatMap((store) =>
          store.create({ integrationID: "openai", value: key("stored"), label: "stored" }),
        ),
      ),
      variables,
    );
    const active = yield* run(
      Service.pipe(Effect.flatMap((integration) => integration.active("openai"))),
      variables,
    );
    expect(active).toEqual({ type: "credential", id: created.id, label: "stored" });
    const value = yield* run(
      Service.pipe(Effect.flatMap((integration) => integration.resolve(active!))),
      variables,
    );
    expect(value && value.type === "key" ? Redacted.value(value.key) : undefined).toBe("stored");
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
    const connection = { type: "credential" as const, id: created.id, label: "fake" };
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
