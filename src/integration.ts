import { Clock, Context, Duration, Effect, Layer } from "effect";
import { FileSystem, HttpClient, HttpClientRequest } from "@effect/platform";
import { Credential } from "./credential.ts";
import { EventBus } from "./effect/EventBus.ts";
import * as ModelCatalog from "./model-catalog.ts";
import { integrations, type Connection, type Integration } from "./auth/integration/index.ts";

export type { Connection, Integration } from "./auth/integration/index.ts";

export type Info = {
  readonly id: string;
  readonly label: string;
  readonly methods: Integration["methods"];
  readonly connections: readonly Connection[];
};

export interface Interface {
  readonly get: (id: string) => Effect.Effect<Info | undefined>;
  readonly list: () => Effect.Effect<readonly Info[]>;
  readonly active: (id: string) => Effect.Effect<Connection | undefined>;
  readonly resolve: (connection: Connection) => Effect.Effect<Credential.Value | undefined>;
  readonly model: (
    integrationID: string,
    model: string,
  ) => Effect.Effect<
    Layer.Layer<import("@effect/ai").LanguageModel.LanguageModel, never, never> | undefined
  >;
}

export class Service extends Context.Tag("amux/Integration")<Service, Interface>() {}

/**
 * The registry, over a set of integration definitions and a model catalog.
 *
 * The catalog is a parameter for the same reason the catalog's own fetcher is
 * one: it is where a provider's API host is written down, and a check about
 * which host an integration ends up asking should not have to reach the
 * network to state it.
 */
export const makeLayer = (
  definitions: readonly Integration[] = integrations,
  catalogLayer: Layer.Layer<
    ModelCatalog.Service,
    never,
    FileSystem.FileSystem
  > = ModelCatalog.Default,
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const credentials = yield* Credential.Service;
      const events = yield* EventBus;
      const catalog = yield* ModelCatalog.Service;
      const byID = new Map(definitions.map((integration) => [integration.id, integration]));

      const connections = (saved: readonly Credential.Info[]): readonly Connection[] =>
        saved.map((credential) => ({
          type: "credential" as const,
          id: credential.id,
          label: credential.label,
        }));

      const find = (id: string) => byID.get(id);
      const refresh = Effect.fnUntraced(function* (
        integration: Integration,
        credential: Credential.Info,
      ) {
        if (credential.value.type === "key" || !integration.refresh) return credential.value;
        const now = yield* Clock.currentTimeMillis;
        if (credential.value.expires > now + Duration.minutes(5).pipe(Duration.toMillis))
          return credential.value;
        const value = yield* credentials
          .refreshOAuth(credential.id, now, integration.refresh)
          .pipe(Effect.orDie);
        if (!value) return credential.value;
        yield* events.publish({
          _tag: "credential.changed",
          integration: credential.integrationID,
        });
        return value;
      });
      const resolve = (connection: Connection) =>
        Effect.gen(function* () {
          const credential = yield* credentials.get(connection.id);
          if (!credential) return undefined;
          const integration = find(credential.integrationID);
          return integration ? yield* refresh(integration, credential) : undefined;
        });

      return {
        get: (id) =>
          Effect.gen(function* () {
            const integration = find(id);
            if (!integration) return undefined;
            return {
              id,
              label: integration.label,
              methods: integration.methods,
              connections: connections(yield* credentials.list(id)),
            };
          }),
        list: () =>
          Effect.gen(function* () {
            const saved = yield* credentials.all();
            return definitions.map((integration) => ({
              id: integration.id,
              label: integration.label,
              methods: integration.methods,
              connections: connections(
                saved.filter((credential) => credential.integrationID === integration.id),
              ),
            }));
          }),
        active: (id) =>
          Effect.gen(function* () {
            const integration = find(id);
            if (!integration) return undefined;
            return connections(yield* credentials.list(id))[0];
          }),
        resolve: (connection) =>
          Effect.gen(function* () {
            const credential = yield* credentials.get(connection.id);
            if (!credential) return undefined;
            const integration = find(credential.integrationID);
            return integration ? yield* refresh(integration, credential) : undefined;
          }),
        model: (integrationID, model) =>
          Effect.gen(function* () {
            const integration = find(integrationID);
            if (!integration) return undefined;
            const authorize = (request: HttpClientRequest.HttpClientRequest) =>
              Effect.gen(function* () {
                const connection = yield* Effect.flatMap(
                  credentials.list(integrationID),
                  (items) =>
                    items[0]
                      ? Effect.succeed({
                          type: "credential" as const,
                          id: items[0].id,
                          label: items[0].label,
                        })
                      : Effect.fail("credential missing"),
                );
                const value = yield* resolve(connection);
                if (!value) return yield* Effect.fail("credential missing");
                return integration.authorize(value, request);
              });
            // The catalog is the one place a provider's host and protocol are
            // written down, so an integration reads them from there rather than
            // carrying a copy. Both are stated per model and fall back to the
            // provider: a gateway names its own protocol once and overrides it
            // only on the models that differ.
            const provider = yield* catalog.provider(integrationID);
            const entry = yield* catalog.model(integrationID, model);
            const apiUrl = entry?.provider?.api ?? provider?.api;
            const npm = entry?.provider?.npm ?? provider?.npm;
            return integration.model({
              model,
              transformClient: (client) =>
                HttpClient.mapRequestEffect(client, authorize as never) as HttpClient.HttpClient,
              ...(apiUrl ? { apiUrl } : {}),
              ...(npm ? { npm } : {}),
            });
          }),
      } satisfies Interface;
    }),
  ).pipe(
    Layer.provide(Credential.Default),
    Layer.provide(EventBus.Default),
    Layer.provide(catalogLayer),
  );

export const layer = makeLayer();

export const Default = layer;
