/**
 * Typed change builders for plugin reducers. Encode owner Schemas on the
 * plugin side; apply never sees a codec closure.
 *
 * Pane / action / provider builders live on the handles those declarations
 * return. `build` only carries the per-call pane counter and result encoder.
 */
import { Effect, Schema as S } from "effect";
import { errorMessage } from "./error-message.ts";
import { type OwnerJsonText } from "./layout.ts";
import {
  PluginReducerError,
  type WorkspaceChange,
  type WorkspaceReadPackage,
  type WorkspaceReducerAnswer,
  type WindowRef,
} from "./workspace-changes.ts";
import { makePaneId, type NewPaneId, type PaneId, type SessionId } from "./workspace-ids.ts";

/**
 * Encode a typed value through its Schema to owner JSON text. Encode failure
 * fails the reducer Effect — never decode-then-encode over unknown input.
 */
export const encodeOwner =
  <A>(schema: S.Codec<A>, label: string) =>
  (value: A): Effect.Effect<OwnerJsonText, PluginReducerError> =>
    S.encodeEffect(S.fromJsonString(schema))(value).pipe(
      Effect.mapError(
        (error) =>
          new PluginReducerError({
            message: `${label}: ${errorMessage(error)}`,
          }),
      ),
    );

/**
 * firstMessage wire payload produced only by a session-provider handle.
 * A hand-built string is not assignable.
 */
export class EncodedFirstMessage {
  readonly _tag = "EncodedFirstMessage" as const;
  constructor(readonly wire: OwnerJsonText) {}
}

export const encodedFirstMessage = (wire: OwnerJsonText): EncodedFirstMessage =>
  new EncodedFirstMessage(wire);

export type WorkspaceChangeBuildOptions<ResultType = unknown> = {
  readonly reads: WorkspaceReadPackage;
  readonly encodeResult?: (value: ResultType) => Effect.Effect<OwnerJsonText, PluginReducerError>;
};

/**
 * Per-call builders: pane id counter + typed result. Place/action/message
 * builders live on the handles declared on the registration.
 */
export type WorkspaceChangeBuild<ResultType = unknown> = {
  /** Next hierarchical pane id for `space`, advancing a local counter. */
  readonly nextPaneId: (spaceId: string) => NewPaneId;
  readonly sessionAdd: (input: {
    readonly id: SessionId;
    readonly target: WindowRef;
    readonly dir: string;
    readonly provider?: string;
    readonly firstMessage?: EncodedFirstMessage;
  }) => WorkspaceChange;
  readonly sessionPlace: (
    input:
      | {
          readonly mode: "split";
          readonly pane: NewPaneId;
          readonly target: WindowRef;
          readonly session: SessionId;
        }
      | {
          readonly mode: "replace";
          readonly target: WindowRef;
          readonly session: SessionId;
        },
  ) => WorkspaceChange;
  readonly result: (value: ResultType) => Effect.Effect<WorkspaceChange, PluginReducerError>;
  readonly answer: (changes: readonly WorkspaceChange[]) => WorkspaceReducerAnswer;
};

export const workspaceChangeBuild = <ResultType = unknown>(
  options: WorkspaceChangeBuildOptions<ResultType>,
): WorkspaceChangeBuild<ResultType> => {
  const paneCounters = { ...options.reads.nextPaneBySpace };

  const nextPaneId = (spaceId: string): NewPaneId => {
    const number = paneCounters[spaceId] ?? 1;
    Object.assign(paneCounters, { [spaceId]: number + 1 });
    return makePaneId(spaceId, number);
  };

  return {
    nextPaneId,
    sessionAdd: (input) => {
      const change: WorkspaceChange = {
        _tag: "session.add",
        id: input.id,
        target: input.target,
        dir: input.dir,
      };
      if (input.provider !== undefined) Object.assign(change, { provider: input.provider });
      if (input.firstMessage !== undefined)
        Object.assign(change, { firstMessage: input.firstMessage.wire });
      return change;
    },
    sessionPlace: (input) => {
      if (input.mode === "split") {
        return {
          _tag: "session.place",
          mode: "split",
          pane: input.pane,
          target: input.target,
          session: input.session,
        };
      }
      return {
        _tag: "session.place",
        mode: "replace",
        target: input.target,
        session: input.session,
      };
    },
    result: (value) =>
      Effect.gen(function* () {
        if (options.encodeResult === undefined) {
          return yield* new PluginReducerError({
            message: "result.set requires a declared result Schema on the command",
          });
        }
        const result = yield* options.encodeResult(value);
        return { _tag: "result.set" as const, result };
      }),
    answer: (changes) => ({ changes: [...changes] }),
  };
};

/** Place change builders need NewPaneId / PaneId in signatures — re-export for handles. */
export type { NewPaneId, PaneId };
