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
import type { Contribution, ContributionTable, PluginInstance } from "./plugin/contributions.ts";
import type { CurrentPlugin, RegistryService } from "./plugin/services.ts";
import { scopedRegistry } from "./plugin/services.ts";

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

/** Lookup over committed contribution rows (daemon and CLI each own one table). */
export type ForeignHarnessAdapterLookup = {
  readonly bySource: (source: string) => ForeignHarnessAdapter | undefined;
  readonly byId: (id: string) => ForeignHarnessAdapter | undefined;
  readonly list: () => readonly ForeignHarnessAdapter[];
  readonly all: () => readonly Contribution<ForeignHarnessAdapter>[];
};

export interface ForeignHarnessAdaptersService
  extends RegistryService<ForeignHarnessAdapter>, ForeignHarnessAdapterLookup {}

export class ForeignHarnessAdaptersTag extends Context.Service<
  ForeignHarnessAdaptersTag,
  ForeignHarnessAdaptersService
>()("amux/ForeignHarnessAdapters") {}

/**
 * One contribution table is the store: bySource / byId / list / all and
 * register all read or write that table.
 */
export const makeForeignHarnessAdapters = (
  table: ContributionTable<ForeignHarnessAdapter>,
): ForeignHarnessAdaptersService =>
  scopedRegistry(
    {
      bySource: (source: string) =>
        table.all().find((entry) => entry.value.source === source)?.value,
      byId: (id: string) => table.all().find((entry) => entry.value.id === id)?.value,
      list: () => table.all().map((entry) => entry.value),
      all: table.all,
    },
    (owner: PluginInstance, adapter: ForeignHarnessAdapter) =>
      table.add(owner, adapter.id, adapter),
  );

export const registerForeignHarnessAdapter = (
  adapter: ForeignHarnessAdapter,
): Effect.Effect<void, never, ForeignHarnessAdaptersTag | CurrentPlugin | Scope.Scope> =>
  ForeignHarnessAdaptersTag.pipe(Effect.flatMap((adapters) => adapters.register(adapter)));
