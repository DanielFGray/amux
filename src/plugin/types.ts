import type { Effect, Scope, Stream } from "effect";
import type { PanelContext } from "../ui/panel.ts";
import type { Panel } from "../ui/regions.tsx";
import type { PaneView } from "../component-pane.tsx";
import type { AttachFrame } from "../effect/AttachProtocol.ts";
import type { CommandSpec } from "../bindings.ts";

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
  readonly frames: (session: string) => Stream.Stream<AttachFrame, unknown>;
  readonly sync: (session: string) => void;
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
