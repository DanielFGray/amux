import type { Effect, Scope, Stream } from "effect";
import type { JSX } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import type { PanelContext } from "../ui/panel.ts";
import type { Panel } from "../ui/regions.tsx";
import type { PaneView } from "../component-pane.tsx";
import type { AttachFrame } from "../effect/AttachProtocol.ts";
import type { CommandSpec } from "../bindings.ts";

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

export interface PluginDefinition<R = Scope.Scope> {
  readonly id: string;
  readonly apiVersion: string;
  readonly effect: (context: PluginHostContext) => Effect.Effect<void, never, R>;
}

export interface PluginHostContext {
  readonly id: string;
  readonly panel: PanelContext;
  readonly kv: PluginKV;
  readonly registerPanel: (panel: Panel) => () => void;
  readonly registerPaneType: (type: string, view: PaneView) => () => void;
  readonly registerBinding: (binding: CommandSpec) => () => void;
  readonly registerSettingsSection: (section: PluginSettingsSection) => () => void;
  readonly registerSpawnProvider: (id: string, provider: () => SpawnProvider) => () => void;
  readonly frames: (session: string) => Stream.Stream<AttachFrame, unknown>;
  readonly sync: (session: string) => void;
}

export interface PluginSettingsSection {
  readonly id: string;
  readonly label: string;
  readonly rows: () => number;
  readonly keys?: (event: KeyEvent, selected: number) => void;
  readonly component: (props: { width: number; height: number; selected: number }) => JSX.Element;
}

export interface PluginKV {
  readonly get: <T>(key: string, defaultValue?: T) => T | undefined;
  readonly set: (key: string, value: unknown) => void;
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

export interface PluginStatus {
  readonly id: string;
  readonly active: boolean;
  readonly error: string | null;
}
