import { Clock, Context, Duration, Effect, Layer, Redacted } from "effect";
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
    connection: Connection,
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

      const connections = (
        integration: Integration,
        saved: readonly Credential.Info[],
      ): readonly Connection[] => [
        ...saved.map((credential) => ({
          type: "credential" as const,
          id: credential.id,
          label: credential.label,
        })),
        ...integration.methods
          .filter(
            (method): method is Extract<Integration["methods"][number], { type: "env" }> =>
              method.type === "env",
          )
          .flatMap((method) =>
            method.names
              .filter((name) => process.env[name])
              .map((name) => ({ type: "env" as const, name })),
          ),
      ];

      const find = (id: string) => byID.get(id);
      const refresh = (integration: Integration, credential: Credential.Info) =>
        Effect.gen(function* () {
          if (credential.value.type === "key" || !integration.refresh) return credential.value;
          const now = yield* Clock.currentTimeMillis;
          if (credential.value.expires > now + Duration.minutes(5).pipe(Duration.toMillis))
            return credential.value;
          const value = yield* integration.refresh(credential.value).pipe(Effect.orDie);
          yield* credentials.update(credential.id, { value });
          yield* events.publish({
            _tag: "credential.changed",
            integration: credential.integrationID,
          });
          return value;
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
              connections: connections(integration, yield* credentials.list(id)),
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
                integration,
                saved.filter((credential) => credential.integrationID === integration.id),
              ),
            }));
          }),
        active: (id) =>
          Effect.gen(function* () {
            const integration = find(id);
            if (!integration) return undefined;
            return connections(integration, yield* credentials.list(id))[0];
          }),
        resolve: (connection) =>
          connection.type === "env"
            ? Effect.succeed(
                process.env[connection.name]
                  ? { type: "key" as const, key: Redacted.make(process.env[connection.name]!) }
                  : undefined,
              )
            : Effect.gen(function* () {
                const credential = yield* credentials.get(connection.id);
                if (!credential) return undefined;
                return yield* refresh(find(credential.integrationID)!, credential);
              }),
        model: (integrationID, connection, model) =>
          Effect.gen(function* () {
            const integration = find(integrationID);
            const value = yield* connection.type === "env"
              ? process.env[connection.name]
                ? Effect.succeed({
                    type: "key" as const,
                    key: Redacted.make(process.env[connection.name]!),
                  })
                : Effect.void.pipe(Effect.as(undefined))
              : Effect.gen(function* () {
                  const credential = yield* credentials.get(connection.id);
                  return credential
                    ? yield* refresh(find(credential.integrationID)!, credential)
                    : undefined;
                });
            return integration && value ? integration.model(value, model) : undefined;
          }),
      } satisfies Interface;
    }),
  ).pipe(Layer.provide(Credential.Default), Layer.provide(EventBus.Default));

export const layer = makeLayer();

export const Default = layer;
