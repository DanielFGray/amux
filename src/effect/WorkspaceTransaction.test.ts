import { testEffect } from "../test-effect.ts";
import { Effect, Layer, Ref } from "effect";
import { expect } from "bun:test";
import { layerDaemonModel } from "./DaemonModel.ts";
import {
  WorkspaceTransaction,
  WorkspaceTransactionSessionOps,
  WorkspaceTransactionWorktreeOps,
  WorkspaceTransactionPersistence,
  WorkspaceTransactionEvents,
  WorkspaceTransactionError,
} from "./WorkspaceTransaction.ts";
import type { PersistedSession, SessionState } from "../session.ts";
import { workspaceFromSession } from "../workspace.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { command } from "../commands.ts";
import type { PreparedSession } from "./SessionSupervisor.ts";
import type { WorktreeSpec } from "../git.ts";
import { makeLayout, layoutPanes } from "../layout.ts";

const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

function singlePaneState(): {
  state: SessionState;
  workspace: WorkspaceSnapshot;
} {
  const spaceId = "space-1";
  const winNum = 1;
  const agentId = "agent-1";
  const paneId = "pane-1";
  const layout = makeLayout({
    root: { type: "pane" as const, id: paneId, agent: agentId, weight: 1 },
    focus: paneId,
  });
  const state: SessionState = {
    version: 1,
    id: "test",
    createdAt: 1,
    updatedAt: 1,
    attached: false,
    activeSpace: spaceId,
    spaces: [
      {
        id: spaceId,
        name: "main",
        dir: "/tmp",
        activeWindow: winNum,
        windows: [
          {
            number: winNum,
            name: null,
            agents: [
              {
                id: agentId,
                name: "sh",
                cmd: ["sh"],
                cwd: "/tmp",
                cols: 80,
                rows: 24,
                exited: false,
                exitCode: null,
              },
            ],
            layout: JSON.stringify(layout),
          },
        ],
      },
    ],
  };
  return { state, workspace: Effect.runSync(workspaceFromSession(state)) };
}

function worktreeSpace(): {
  state: SessionState;
  workspace: WorkspaceSnapshot;
} {
  const spaceId = "wt-space";
  const state: SessionState = {
    version: 1,
    id: "test",
    createdAt: 1,
    updatedAt: 1,
    attached: false,
    activeSpace: spaceId,
    spaces: [
      {
        id: spaceId,
        name: "worktree-space",
        dir: "/tmp/wt",
        activeWindow: null,
        windows: [],
        worktree: { branch: "feat", repo: "/tmp/repo", path: "/tmp/wt/feat" },
      },
    ],
  };
  return { state, workspace: Effect.runSync(workspaceFromSession(state)) };
}

interface FakeSessionState {
  killed: string[];
  written: { id: string; data: string }[];
  prepared: string[];
  activated: string[];
  aborted: string[];
  fail: boolean;
}

function trackingSessionOps(stateRef: Ref.Ref<FakeSessionState>) {
  return {
    prepare: (agent: PersistedSession) =>
      Effect.gen(function* () {
        const st = yield* Ref.get(stateRef);
        if (st.fail)
          return yield* Effect.die(
            new WorkspaceTransactionError({
              message: "injected prepare failure",
            }),
          );
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          prepared: [...s.prepared, agent.id],
        }));
        const activate = Ref.update(stateRef, (s) => ({
          ...s,
          activated: [...s.activated, agent.id],
        }));
        const abort = Ref.update(stateRef, (s) => ({
          ...s,
          aborted: [...s.aborted, agent.id],
        }));
        return {
          session: { id: agent.id } as any,
          activate,
          abort,
        } satisfies PreparedSession;
      }),
    kill: (id: string) =>
      Effect.gen(function* () {
        const st = yield* Ref.get(stateRef);
        if (st.fail)
          return yield* Effect.die(
            new WorkspaceTransactionError({ message: "injected kill failure" }),
          );
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          killed: [...s.killed, id],
        }));
      }),
    write: (id: string, data: string) =>
      Effect.gen(function* () {
        const st = yield* Ref.get(stateRef);
        if (st.fail)
          return yield* Effect.die(
            new WorkspaceTransactionError({
              message: "injected write failure",
            }),
          );
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          written: [...s.written, { id, data }],
        }));
      }),
    interrupt: () => Effect.void,
    decide: () => Effect.void,
  };
}

interface FakeWorktreeState {
  added: { repo: string; spec: WorktreeSpec; path: string }[];
  removed: { repo: string; path: string; force: boolean }[];
  dirty: boolean;
  fail: boolean;
}

function trackingWorktreeOps(stateRef: Ref.Ref<FakeWorktreeState>) {
  return {
    add: (repo: string, spec: WorktreeSpec, path: string) =>
      Effect.gen(function* () {
        const st = yield* Ref.get(stateRef);
        if (st.fail)
          return yield* Effect.die(
            new WorkspaceTransactionError({
              message: "injected worktree add failure",
            }),
          );
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          added: [...s.added, { repo, spec, path }],
        }));
      }),
    remove: (repo: string, path: string, force = false) =>
      Effect.gen(function* () {
        const st = yield* Ref.get(stateRef);
        if (st.fail)
          return yield* Effect.die(
            new WorkspaceTransactionError({
              message: "injected worktree remove failure",
            }),
          );
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          removed: [...s.removed, { repo, path, force }],
        }));
      }),
    isDirty: (_path: string) =>
      Effect.gen(function* () {
        const st = yield* Ref.get(stateRef);
        if (st.fail)
          return yield* Effect.die(
            new WorkspaceTransactionError({
              message: "injected worktree dirty failure",
            }),
          );
        return st.dirty;
      }),
  };
}

interface FakePersistenceState {
  persisted: SessionState[];
  retried: { state: SessionState; reason: string }[];
}

function trackingPersistence(stateRef: Ref.Ref<FakePersistenceState>) {
  return {
    persist: (state: SessionState) =>
      Ref.update(stateRef, (s) => ({
        ...s,
        persisted: [...s.persisted, state],
      })),
    persistUntilSuccess: (state: SessionState, reason: string) =>
      Ref.update(stateRef, (s) => ({
        ...s,
        retried: [...s.retried, { state, reason }],
        persisted: [...s.persisted, state],
      })),
  };
}

interface FakeEventsState {
  workspaceEvents: { before: unknown; after: unknown }[];
  workspaceFrames: unknown[];
}

function trackingEvents(stateRef: Ref.Ref<FakeEventsState>) {
  return {
    publishWorkspaceEvents: (before: unknown, after: unknown) =>
      Ref.update(stateRef, (s) => ({
        ...s,
        workspaceEvents: [...s.workspaceEvents, { before, after }],
      })),
    publishWorkspaceFrame: (snapshot: unknown) =>
      Ref.update(stateRef, (s) => ({
        ...s,
        workspaceFrames: [...s.workspaceFrames, snapshot],
      })),
  };
}

function testLayer(
  initial: { state: SessionState; workspace: WorkspaceSnapshot },
  opts?: {
    sessionFail?: boolean;
    worktreeFail?: boolean;
    worktreeDirty?: boolean;
  },
) {
  const sessionRef = Ref.unsafeMake<FakeSessionState>({
    killed: [],
    written: [],
    prepared: [],
    activated: [],
    aborted: [],
    fail: opts?.sessionFail ?? false,
  });
  const worktreeRef = Ref.unsafeMake<FakeWorktreeState>({
    added: [],
    removed: [],
    dirty: opts?.worktreeDirty ?? false,
    fail: opts?.worktreeFail ?? false,
  });
  const persistRef = Ref.unsafeMake<FakePersistenceState>({
    persisted: [],
    retried: [],
  });
  const eventsRef = Ref.unsafeMake<FakeEventsState>({
    workspaceEvents: [],
    workspaceFrames: [],
  });

  const layer = Layer.provide(
    WorkspaceTransaction.Default,
    layerDaemonModel(initial),
  ).pipe(
    Layer.provide(
      Layer.succeed(
        WorkspaceTransactionSessionOps,
        trackingSessionOps(sessionRef),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        WorkspaceTransactionWorktreeOps,
        trackingWorktreeOps(worktreeRef),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        WorkspaceTransactionPersistence,
        trackingPersistence(persistRef),
      ),
    ),
    Layer.provide(
      Layer.succeed(WorkspaceTransactionEvents, trackingEvents(eventsRef)),
    ),
  );

  return { layer, sessionRef, worktreeRef, persistRef, eventsRef };
}

testEffect("rejects stale revision", () => {
  const initial = singlePaneState();
  const { layer } = testLayer(initial);
  return Effect.gen(function* () {
    const tx = yield* WorkspaceTransaction;
    const result = yield* Effect.exit(
      tx.run(command("space.rename", { name: "foo" }), 999, context),
    );
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(layer));
});

testEffect("rejects non-workspace commands", () => {
  const initial = singlePaneState();
  const { layer } = testLayer(initial);
  return Effect.gen(function* () {
    const tx = yield* WorkspaceTransaction;
    const result = yield* Effect.exit(
      tx.run(command("app.quit"), initial.workspace.revision, context),
    );
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(layer));
});

testEffect("executes a non-destructive command and publishes events", () => {
  const initial = singlePaneState();
  const { layer } = testLayer(initial);
  return Effect.gen(function* () {
    const tx = yield* WorkspaceTransaction;
    const result = yield* tx.run(
      command("space.rename", { name: "renamed" }),
      initial.workspace.revision,
      context,
    );
    expect(result.revision).toBe(1);
    expect(result.spaces[0]!.name).toBe("renamed");
  }).pipe(Effect.provide(layer));
});

testEffect(
  "rolls back prepared sessions and does not persist on session failure",
  () => {
    const initial = singlePaneState();
    const { layer, sessionRef, persistRef } = testLayer(initial, {
      sessionFail: true,
    });
    return Effect.gen(function* () {
      const tx = yield* WorkspaceTransaction;
      const result = yield* Effect.exit(
        tx.run(
          command("pane.split", { axis: "row" }),
          initial.workspace.revision,
          context,
        ),
      );
      expect(result._tag).toBe("Failure");

      const persisted = yield* Ref.get(persistRef);
      expect(persisted.persisted).toHaveLength(0);

      const sessions = yield* Ref.get(sessionRef);
      expect(sessions.activated).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  },
);

testEffect("activates prepared sessions after successful commit", () => {
  const initial = singlePaneState();
  const { layer, sessionRef } = testLayer(initial);
  return Effect.gen(function* () {
    const tx = yield* WorkspaceTransaction;
    const result = yield* tx.run(
      command("pane.split", { axis: "row" }),
      initial.workspace.revision,
      context,
    );
    expect(result.revision).toBe(1);
    const panes = layoutPanes(result.spaces[0]!.windows[0]!.layout.root);
    expect(panes).toHaveLength(2);

    const sessions = yield* Ref.get(sessionRef);
    expect(sessions.prepared.length).toBe(1);
    expect(sessions.activated.length).toBe(1);
  }).pipe(Effect.provide(layer));
});

testEffect("rejects worktree removal when dirty", () => {
  const initial = worktreeSpace();
  const { layer } = testLayer(initial, { worktreeDirty: true });
  return Effect.gen(function* () {
    const tx = yield* WorkspaceTransaction;
    const result = yield* Effect.exit(
      tx.run(
        command("space.close", { space: "wt-space" }),
        initial.workspace.revision,
        context,
      ),
    );
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(layer));
});
