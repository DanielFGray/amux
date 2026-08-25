import { Effect, type Context, type Option, type Scope, type Stream } from "effect";
import type { Schema } from "effect";
import { CurrentPlugin, type PluginService } from "./services.ts";
import type { JSX } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import type { PanelContext } from "../ui/panel.ts";
import type { AttachFrame } from "../effect/AttachProtocol.ts";
import type { JsonValue } from "../layout.ts";

export interface SpawnProvider {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Environment variable names to strip from the inherited environment before
   * spawning. A provider key exported into the daemon's environment must not
   * reach a worker's `environ`. The harness declares these, because it is the
   * thing that knows which variables are credentials.
   */
  readonly stripEnv?: readonly string[];
}

export interface PluginDefinition {
  readonly id: string;
  readonly apiVersion: string;
  /**
   * Services this plugin cannot run without. It does not start until every one
   * of them has a provider, and it is torn down and re-gated when a provider
   * leaves. `definePlugin` is what checks these against the effect's
   * requirements; the host holds them erased, because it holds many plugins
   * with different requirements in one map.
   */
  readonly inject?: readonly PluginService[];
  readonly activate: (
    context: PluginHostContext,
    provided: Context.Context<never>,
  ) => Effect.Effect<void, never, Scope.Scope | CurrentPlugin>;
}

export type TagIdentifier<T> = T extends Context.Tag<infer Id, infer _Service> ? Id : never;
export type PluginRequirements<Tags extends readonly PluginService[]> =
  | TagIdentifier<Tags[number]>
  | Context.Tag.Identifier<CurrentPlugin>
  | Scope.Scope;

/**
 * A plugin, with its injected tags checked against what its effect requires.
 *
 * Writing the object literal directly types the effect's requirements as
 * whatever the author wrote, and a tag left out of `inject` would then be a
 * plugin that suspends on nothing and dies on a missing service. Inferring the
 * tags here makes the two halves one declaration.
 */
export const definePlugin = <const Tags extends readonly PluginService[] = []>(definition: {
  readonly id: string;
  readonly apiVersion: string;
  readonly inject?: Tags;
  readonly effect: (
    context: PluginHostContext,
  ) => Effect.Effect<void, never, PluginRequirements<Tags>>;
}): PluginDefinition => ({
  id: definition.id,
  apiVersion: definition.apiVersion,
  inject: definition.inject,
  activate: (context, provided) =>
    Effect.provide(
      definition.effect(context),
      provided as Context.Context<TagIdentifier<Tags[number]>>,
    ),
});

export interface PluginHostContext {
  readonly id: string;
  readonly panel: PanelContext;
  readonly kv: PluginKV;
  /** Publish a service other plugins may inject. It is withdrawn when this plugin stops. */
  readonly provide: <Id, S>(tag: Context.Tag<Id, S>, service: S) => () => void;
  /** Read a service without depending on it. `inject` is what makes the host wait. */
  readonly get: <Id, S>(tag: Context.Tag<Id, S>) => Option.Option<S>;
  readonly frames: (session: string) => Stream.Stream<AttachFrame, never>;
  readonly sync: (session: string) => void;
}

export interface PluginSettingsSection {
  readonly id: string;
  readonly label: string;
  readonly rows: () => number;
  readonly keys?: (event: KeyEvent, selected: number) => void;
  readonly component: (props: { width: number; height: number; selected: number }) => JSX.Element;
}

export interface PluginKVKey<T extends JsonValue> {
  readonly key: string;
  readonly schema: Schema.Schema<T>;
}

export interface PluginKV {
  readonly get: <T extends JsonValue>(key: PluginKVKey<T>, defaultValue?: T) => T | undefined;
  readonly set: <T extends JsonValue>(key: PluginKVKey<T>, value: T) => void;
  readonly ready: boolean;
}

export type PluginErrorPhase = "activate" | "deactivate" | "render";

export interface PluginErrorEvent {
  readonly pluginId: string;
  readonly slot?: string;
  readonly phase: PluginErrorPhase;
  readonly source: "host" | "plugin";
  readonly error: Error;
  readonly timestamp: number;
}

/**
 * A plugin the host is holding. Being listed at all is what "running" means —
 * a plugin that failed is removed, and its failure goes out on `onError`, so
 * there is no error to report here and no `active` flag to set.
 */
export interface PluginStatus {
  readonly id: string;
  /** Injected tags with no provider yet; empty for a plugin that has started. */
  readonly waitingFor: readonly string[];
}
