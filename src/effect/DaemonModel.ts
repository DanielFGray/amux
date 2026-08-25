/**
 * The daemon's renderer-free workspace model — a single mutable Ref and an
 * ordered mutation queue, exposed as a scoped Effect service.
 *
 * The daemon injects persistence and event publication callbacks into model
 * transactions; this service owns no I/O beyond the queue consumer fiber.
 */

import { Context, Deferred, Effect, Layer, Queue, Ref, Schema as S, Scope } from "effect";
import type { SessionAttachment, SessionState } from "../session.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";

export class DaemonModelError extends S.TaggedError<DaemonModelError>()("DaemonModelError", {
  message: S.String,
}) {}

export interface DaemonState {
  state: SessionState;
  workspace: WorkspaceSnapshot;
  attachments: Map<string, SessionAttachment>;
  heartbeatError: string | null;
  durableObligations: Map<symbol, string>;
  closing: boolean;
  cancelPersistence: boolean;
}

type Mutation = Effect.Effect<void, never>;

export interface DaemonModelService {
  readonly enqueue: <A, E>(effect: Effect.Effect<A, E, never>) => Effect.Effect<A, E>;

  readonly get: Effect.Effect<DaemonState, never>;
  readonly state: Effect.Effect<SessionState, never>;
  readonly workspace: Effect.Effect<WorkspaceSnapshot, never>;
  readonly attachedClients: Effect.Effect<string[], never>;

  readonly attach: (
    client: string,
    connection: string,
    onPersist: (state: SessionState) => Effect.Effect<void, DaemonModelError>,
  ) => Effect.Effect<void, DaemonModelError>;

  readonly detach: (
    client: string,
    connection: string,
    onPersist: (state: SessionState) => Effect.Effect<void, DaemonModelError>,
  ) => Effect.Effect<void, DaemonModelError>;

  readonly touch: (client: string, connection: string) => Effect.Effect<void>;

  readonly commitWorkspace: (
    workspace: WorkspaceSnapshot,
    sessionState: SessionState,
  ) => Effect.Effect<void>;

  readonly addObligation: (reason: string) => Effect.Effect<symbol>;
  readonly updateObligation: (obligation: symbol, detail: string) => Effect.Effect<void>;
  readonly clearObligation: (obligation: symbol) => Effect.Effect<void>;

  readonly markClosing: Effect.Effect<void>;
  readonly isClosing: Effect.Effect<boolean>;
  readonly markCancelPersistence: Effect.Effect<void>;

  readonly setHeartbeatError: (error: string | null) => Effect.Effect<void>;
  readonly heartbeatError: Effect.Effect<string | null>;

  readonly setAttachments: (attachments: Map<string, SessionAttachment>) => Effect.Effect<void>;
  readonly updateState: (state: SessionState) => Effect.Effect<void>;
}

export class DaemonModel extends Context.Tag("DaemonModel")<DaemonModel, DaemonModelService>() {}

export const layerDaemonModel = (initial: {
  state: SessionState;
  workspace: WorkspaceSnapshot;
}): Layer.Layer<DaemonModel, never, Scope.Scope> =>
  Layer.scoped(
    DaemonModel,
    Effect.gen(function* () {
      const daemonRef = yield* Ref.make<DaemonState>({
        state: initial.state,
        workspace: initial.workspace,
        attachments: new Map(),
        heartbeatError: null,
        durableObligations: new Map(),
        closing: false,
        cancelPersistence: false,
      });

      const mutationQueue = yield* Queue.unbounded<Mutation>();
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(mutationQueue).pipe(
            Effect.flatMap((mutation) => mutation),
          ),
        ),
      );

      const enqueue = <A, E>(effect: Effect.Effect<A, E, never>): Effect.Effect<A, E> =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<A, E>();
          yield* Queue.offer(mutationQueue, Effect.intoDeferred(effect, done).pipe(Effect.asVoid));
          return yield* Deferred.await(done);
        });

      const get: Effect.Effect<DaemonState, never> = Ref.get(daemonRef);
      const state = Ref.get(daemonRef).pipe(Effect.map((s) => structuredClone(s.state)));
      const workspace = Ref.get(daemonRef).pipe(Effect.map((s) => structuredClone(s.workspace)));
      const attachedClients = Ref.get(daemonRef).pipe(
        Effect.map((s) => [...s.attachments.values()].map((a) => a.client)),
      );

      const attach = (
        client: string,
        connection: string,
        onPersist: (s: SessionState) => Effect.Effect<void, DaemonModelError>,
      ): Effect.Effect<void, DaemonModelError> =>
        enqueue(
          Effect.gen(function* () {
            const cur = yield* Ref.get(daemonRef);
            const now = Date.now();
            const attachments = new Map(cur.attachments);
            attachments.set(connection, { client, attachedSince: now, attachLastSeen: now });
            const newState = { ...cur.state, attached: true, updatedAt: now };
            yield* onPersist(newState).pipe(
              Effect.catchAll(
                (error) =>
                  new DaemonModelError({
                    message: error instanceof Error ? error.message : String(error),
                  }),
              ),
            );
            yield* Ref.set(daemonRef, { ...cur, attachments, state: newState });
          }),
        );

      const detach = (
        client: string,
        connection: string,
        onPersist: (s: SessionState) => Effect.Effect<void, DaemonModelError>,
      ): Effect.Effect<void, DaemonModelError> =>
        enqueue(
          Effect.gen(function* () {
            const cur = yield* Ref.get(daemonRef);
            const att = cur.attachments.get(connection);
            if (!att || att.client !== client) return;
            const attachments = new Map(cur.attachments);
            attachments.delete(connection);
            const newState = {
              ...cur.state,
              attached: attachments.size > 0,
              updatedAt: Date.now(),
            };
            yield* onPersist(newState).pipe(
              Effect.catchAll(
                (error) =>
                  new DaemonModelError({
                    message: error instanceof Error ? error.message : String(error),
                  }),
              ),
            );
            yield* Ref.set(daemonRef, { ...cur, attachments, state: newState });
          }),
        );

      const touch = (client: string, connection: string) =>
        Ref.modify(daemonRef, (cur) => {
          const att = cur.attachments.get(connection);
          if (att?.client === client) {
            const attachments = new Map(cur.attachments);
            attachments.set(connection, { ...att, attachLastSeen: Date.now() });
            return [undefined as void, { ...cur, attachments }];
          }
          return [undefined as void, cur];
        });

      const commitWorkspace = (next: WorkspaceSnapshot, sessionState: SessionState) =>
        Ref.update(daemonRef, (cur) => ({ ...cur, workspace: next, state: sessionState }));

      const addObligation = (reason: string) =>
        Ref.modify(daemonRef, (cur) => {
          const sym = Symbol(reason);
          cur.durableObligations.set(sym, `${reason} is waiting for durable storage`);
          return [sym, cur];
        });

      const updateObligation = (obligation: symbol, detail: string) =>
        Ref.update(daemonRef, (s) => {
          if (!s.durableObligations.has(obligation)) return s;
          s.durableObligations.set(obligation, detail);
          return s;
        });

      const clearObligation = (obligation: symbol) =>
        Ref.update(daemonRef, (s) => {
          s.durableObligations.delete(obligation);
          return s;
        });

      const markClosing = Ref.update(daemonRef, (s) => ({ ...s, closing: true }));
      const isClosing = Ref.get(daemonRef).pipe(Effect.map((s) => s.closing));
      const markCancelPersistence = Ref.update(daemonRef, (s) => ({
        ...s,
        cancelPersistence: true,
      }));

      const setHeartbeatError = (error: string | null) =>
        Ref.update(daemonRef, (s) => ({ ...s, heartbeatError: error }));
      const heartbeatError_ = Ref.get(daemonRef).pipe(Effect.map((s) => s.heartbeatError));

      const setAttachments = (attachments: Map<string, SessionAttachment>) =>
        Ref.update(daemonRef, (cur) => ({ ...cur, attachments }));
      const updateState = (sessionState: SessionState) =>
        Ref.update(daemonRef, (cur) => ({ ...cur, state: sessionState }));

      return {
        enqueue,
        get,
        state,
        workspace,
        attachedClients,
        attach,
        detach,
        touch,
        commitWorkspace,
        addObligation,
        updateObligation,
        clearObligation,
        markClosing,
        isClosing,
        markCancelPersistence,
        setHeartbeatError,
        heartbeatError: heartbeatError_,
        setAttachments,
        updateState,
      } satisfies DaemonModelService;
    }),
  );
