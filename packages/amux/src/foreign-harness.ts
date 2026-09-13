/**
 * Foreign PTY harness adapters — resume argv + hook install for agents that
 * run as ordinary pane programs (claude/codex/cursor/opencode/…), not the native
 * harness's provider auth (`Integration`).
 *
 * Provider and harness axes sometimes share a name (claude, codex) and
 * sometimes do not (openrouter = provider only; pi = harness only). This
 * registry is harness-scoped only.
 */
import { Context, Effect, Schema as S, type Scope } from "effect";
import type { Option } from "effect/Option";
import type * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import type { AgentResumePlan } from "./agent-resume.ts";
import type { AgentSessionRef, OfficialAgentSource } from "./agent-session.ts";
import type { CurrentPlugin, RegistryService } from "./plugin/services.ts";
import { scopedRegistry } from "./plugin/services.ts";
import type { PluginInstance } from "./plugin/contributions.ts";

export class ForeignHarnessHookError extends S.TaggedError<ForeignHarnessHookError>()(
  "ForeignHarnessHookError",
  { message: S.String },
) {}

export class ForeignHarnessPlanResumeError extends S.TaggedError<ForeignHarnessPlanResumeError>()(
  "ForeignHarnessPlanResumeError",
  {
    adapter: S.String,
    message: S.String,
  },
) {}

export type ForeignHarnessAdapter = {
  readonly id: string;
  readonly source: OfficialAgentSource;
  readonly label: string;
  readonly integrationVersion: number;
  readonly planResume: (
    ref: AgentSessionRef,
  ) => Effect.Effect<Option<AgentResumePlan>, ForeignHarnessPlanResumeError>;
  readonly hooks: {
    readonly install: (
      home?: string,
    ) => Effect.Effect<string, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem>;
    readonly uninstall: (
      home?: string,
    ) => Effect.Effect<boolean, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem>;
  };
};

/** Lookup table for registered foreign-harness adapters (daemon and CLI each own one). */
export type ForeignHarnessAdapterLookup = {
  readonly bySource: (source: string) => ForeignHarnessAdapter | undefined;
  readonly byId: (id: string) => ForeignHarnessAdapter | undefined;
  readonly list: () => readonly ForeignHarnessAdapter[];
};

/**
 * In-memory adapter table. Daemon and CLI each own one; plugins register
 * into it through `ForeignHarnessAdaptersTag`.
 */
export class ForeignHarnessAdapterTable implements ForeignHarnessAdapterLookup {
  readonly #bySource = new Map<string, ForeignHarnessAdapter>();
  readonly #byId = new Map<string, ForeignHarnessAdapter>();

  register(adapter: ForeignHarnessAdapter): () => void {
    this.#bySource.set(adapter.source, adapter);
    this.#byId.set(adapter.id, adapter);
    return () => {
      if (this.#bySource.get(adapter.source) === adapter) this.#bySource.delete(adapter.source);
      if (this.#byId.get(adapter.id) === adapter) this.#byId.delete(adapter.id);
    };
  }

  bySource(source: string): ForeignHarnessAdapter | undefined {
    return this.#bySource.get(source);
  }

  byId(id: string): ForeignHarnessAdapter | undefined {
    return this.#byId.get(id);
  }

  list(): readonly ForeignHarnessAdapter[] {
    return [...this.#byId.values()];
  }
}

export interface ForeignHarnessAdaptersService
  extends RegistryService<ForeignHarnessAdapter>, ForeignHarnessAdapterLookup {}

export class ForeignHarnessAdaptersTag extends Context.Service<
  ForeignHarnessAdaptersTag,
  ForeignHarnessAdaptersService
>()("amux/ForeignHarnessAdapters") {}

export const makeForeignHarnessAdapters = (
  table: ForeignHarnessAdapterTable,
  register: (owner: PluginInstance, adapter: ForeignHarnessAdapter) => () => void,
): ForeignHarnessAdaptersService =>
  scopedRegistry(
    {
      bySource: (source: string) => table.bySource(source),
      byId: (id: string) => table.byId(id),
      list: () => table.list(),
    },
    register,
  );

export const registerForeignHarnessAdapter = (
  adapter: ForeignHarnessAdapter,
): Effect.Effect<void, never, ForeignHarnessAdaptersTag | CurrentPlugin | Scope.Scope> =>
  ForeignHarnessAdaptersTag.pipe(Effect.flatMap((adapters) => adapters.register(adapter)));
