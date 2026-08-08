import { Clock, Context, Duration, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Credential } from "./credential.ts";
import { EventBus } from "./effect/EventBus.ts";
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

export const makeLayer = (definitions: readonly Integration[] = integrations) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const credentials = yield* Credential.Service;
      const events = yield* EventBus;
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
        const value = yield* credentials.refreshOAuth(credential.id, now, integration.refresh).pipe(Effect.orDie);
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
              connections: connections(saved.filter((credential) => credential.integrationID === integration.id)),
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
                const connection = yield* Effect.flatMap(credentials.list(integrationID), (items) =>
                  items[0] ? Effect.succeed({ type: "credential" as const, id: items[0].id, label: items[0].label }) : Effect.fail("credential missing"),
                );
                const value = yield* resolve(connection);
                if (!value) return yield* Effect.fail("credential missing");
                return integration.authorize(value, request);
              });
            return integration.model(model, (client) =>
              HttpClient.mapRequestEffect(client, authorize as never) as HttpClient.HttpClient,
            );
          }),
      } satisfies Interface;
    }),
  ).pipe(Layer.provide(Credential.Default), Layer.provide(EventBus.Default));

export const layer = makeLayer();

export const Default = layer;
