/**
 * Author a daemon command with field decode before reduce/run and typed
 * per-call builders (pane counter + result). Place/action/message builders
 * live on the handles declared beside the registration.
 */
import { Effect, Schema as S, SchemaIssue } from "effect";
import type { Meta, RuntimeCommand } from "./commands.ts";
import { CommandError } from "./commands.ts";
import type { DaemonSessionCommandContext, DefinedDaemonCommand } from "./plugin/services.ts";
import type { PluginActionRegistration } from "./effect/WorkspaceTransaction.ts";
import type { PaneTypeRegistration } from "./pane-descriptors.ts";
import type { ProviderMessageRegistration } from "./session-provider-messages.ts";
import type { PluginWorkspaceReducer } from "./workspace.ts";
import type { WorkspaceCommandContext } from "./workspace-command-context.ts";
import {
  PluginReducerError,
  type WorkspaceReadPackage,
  type WorkspaceReducerAnswer,
} from "./workspace-changes.ts";
import {
  encodeOwner,
  workspaceChangeBuild,
  type WorkspaceChangeBuild,
} from "./workspace-change-builders.ts";
import type { DaemonSessions } from "./daemon-sessions.ts";
import type { JsonValue } from "./effect/AttachProtocol.ts";

const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

const stripTag = (command: RuntimeCommand): { readonly [key: string]: JsonValue } => {
  const { _tag: _drop, ...fields } = command;
  return fields;
};

export type DefineDaemonCommandReduceInput<A, Result> = {
  readonly command: A & { readonly _tag: string };
  readonly context: WorkspaceCommandContext;
  readonly reads: WorkspaceReadPackage;
  readonly build: WorkspaceChangeBuild<Result>;
};

export function defineDaemonCommand<A, Result = unknown>(spec: {
  readonly tag: string;
  readonly fields: S.Codec<A> & { readonly fields: S.Struct.Fields };
  readonly meta: Meta;
  readonly resources: (args: A) => readonly string[];
  readonly result?: S.Codec<Result>;
  readonly paneTypes?: readonly PaneTypeRegistration[];
  readonly providers?: readonly ProviderMessageRegistration[];
  readonly actions?: readonly PluginActionRegistration[];
  readonly reduce?: (
    input: DefineDaemonCommandReduceInput<A, Result>,
  ) => Effect.Effect<WorkspaceReducerAnswer, PluginReducerError>;
  readonly run?: (
    command: A & { readonly _tag: string },
    context: DaemonSessionCommandContext,
  ) => Effect.Effect<unknown, CommandError, DaemonSessions>;
}): DefinedDaemonCommand {
  const decodeCommandFields = (command: RuntimeCommand): Effect.Effect<A, PluginReducerError> =>
    S.decodeUnknownEffect(spec.fields)(stripTag(command)).pipe(
      Effect.mapError(
        (error) =>
          new PluginReducerError({
            message: `${spec.tag}: ${formatSchemaIssue(error.issue)}`,
          }),
      ),
    );

  const reduceAuthor = spec.reduce;
  const runAuthor = spec.run;

  const reduce: PluginWorkspaceReducer | undefined =
    reduceAuthor === undefined
      ? undefined
      : (input) =>
          Effect.gen(function* () {
            const decoded = yield* decodeCommandFields(input.command);
            const build = workspaceChangeBuild<Result>({
              reads: input.reads,
              encodeResult:
                spec.result === undefined ? undefined : encodeOwner(spec.result, "result.set"),
            });
            return yield* reduceAuthor({
              command: { ...decoded, _tag: spec.tag },
              context: input.context,
              reads: input.reads,
              build,
            });
          });

  const run =
    runAuthor === undefined
      ? undefined
      : (command: RuntimeCommand, context: DaemonSessionCommandContext) =>
          Effect.gen(function* () {
            const decoded = yield* decodeCommandFields(command).pipe(
              Effect.mapError(
                (error) =>
                  new CommandError({
                    message: error.message,
                  }),
              ),
            );
            return yield* runAuthor({ ...decoded, _tag: spec.tag }, context);
          });

  const registration: DefinedDaemonCommand = {
    tag: spec.tag,
    fields: spec.fields.fields,
    meta: spec.meta,
    // Typed `A` — callers (CLI/skill) already decoded through the same fields.
    resources: spec.resources,
    __brand: "DefinedDaemonCommand",
  };
  if (spec.result !== undefined) Object.assign(registration, { result: spec.result });
  if (reduce !== undefined) Object.assign(registration, { reduce });
  if (run !== undefined) Object.assign(registration, { run });
  if (spec.actions !== undefined) Object.assign(registration, { actions: spec.actions });
  if (spec.paneTypes !== undefined) Object.assign(registration, { paneTypes: spec.paneTypes });
  if (spec.providers !== undefined) Object.assign(registration, { providers: spec.providers });
  return registration;
}
