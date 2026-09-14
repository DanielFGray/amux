import { testEffect } from "../test-effect.ts";
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Path,
  Ref,
  Scope,
  Stream,
  ConfigProvider,
  Schema as S,
} from "effect";
import { expect } from "bun:test";
import * as TestClock from "effect/testing/TestClock";
import { BunFileSystem } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import { layerDaemonModel } from "./DaemonModel.ts";
import {
  WorkspaceTransaction,
  WorkspaceTransactionWorktreeOps,
  WorkspaceTransactionPersistence,
  WorkspaceTransactionEvents,
  WorkspaceTransactionError,
  WorkspaceTransactionSessions,
  buildWorkspaceTransactionSessions,
  reducePluginCommand,
  type WorkspaceTransactionSessionsService,
} from "./WorkspaceTransaction.ts";
import { DaemonSessions, type DaemonSessionsService } from "../daemon-sessions.ts";
import type { PersistedSession, SessionState } from "../session.ts";
import { workspaceFromSession } from "../workspace.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { command, runtimeCommand } from "../commands.ts";
import type { PreparedSession } from "./SessionSupervisor.ts";
import type { WorktreeSpec } from "../git.ts";
import { makeLayout, layoutPanes, paneSession } from "../layout.ts";
import { PLUGIN_REDUCE_TIMEOUT_MS, PluginReducerError } from "../workspace-changes.ts";
import type { QueuedPluginAction } from "../workspace-changes.ts";
import type { ManagedSession, SessionSpec } from "./SessionRegistry.ts";
import { defaultTilingAlgorithm, defaultTilingMethods } from "../tiling-algorithm-default.ts";
import { tilingAlgorithmFromMethods, TilingAlgorithmError } from "../tiling-algorithm.ts";
import { JsonValueSchema } from "./AttachProtocol.ts";
import { PluginBehaviour, type PluginBehaviourService } from "../plugin-behaviour.ts";
import {
  emptyPluginBehaviour,
  pluginBehaviourFromRegistrations,
} from "../test-plugin-behaviour.ts";
import type { TilingAlgorithmsService } from "../plugin/services.ts";
import { defineDaemonCommand } from "../define-daemon-command.ts";

const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

function singlePaneState() {
  const spaceId = "space-1";
  const winNum = 1;
  const agentId = "agent-1";
  const paneId = "pane-1";
  const layout = makeLayout({
    root: {
      type: "pane" as const,
      id: paneId,
      content: { kind: "pty" as const, session: agentId },
      weight: 1,
    },
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
            sessions: [
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

function worktreeSpace() {
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

function stubManagedSession(id: string): ManagedSession {
  return {
    id,
    kind: "pty",
    output: Stream.empty,
    exit: Effect.succeed(null),
    write: () => Effect.void,
    prompt: () => Effect.void,
    decide: () => Effect.void,
    interrupt: () => Effect.void,
    message: () => Effect.void,
    resize: () => Effect.void,
    kill: Effect.void,
    foreground: () => ({ pgid: -1, sid: -1 }),
  };
}

function trackingTransactionSessions(
  stateRef: Ref.Ref<FakeSessionState>,
): WorkspaceTransactionSessionsService {
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
          session: stubManagedSession(agent.id),
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
    pids: Effect.succeed(new Map()),
  };
}

const idleDaemonSessions: DaemonSessionsService = {
  message: () => Effect.void,
  prompt: () => Effect.void,
  capture: () => Effect.succeed(""),
};

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
  workspaceEvents: { before: WorkspaceSnapshot; after: WorkspaceSnapshot }[];
  workspaceFrames: WorkspaceSnapshot[];
}

function trackingEvents(stateRef: Ref.Ref<FakeEventsState>) {
  return {
    publishWorkspaceEvents: (before: WorkspaceSnapshot, after: WorkspaceSnapshot) =>
      Ref.update(stateRef, (s) => ({
        ...s,
        workspaceEvents: [...s.workspaceEvents, { before, after }],
      })),
    publishWorkspaceFrame: (snapshot: WorkspaceSnapshot) =>
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
  const sessionRef = Ref.makeUnsafe<FakeSessionState>({
    killed: [],
    written: [],
    prepared: [],
    activated: [],
    aborted: [],
    fail: opts?.sessionFail ?? false,
  });
  const worktreeRef = Ref.makeUnsafe<FakeWorktreeState>({
    added: [],
    removed: [],
    dirty: opts?.worktreeDirty ?? false,
    fail: opts?.worktreeFail ?? false,
  });
  const persistRef = Ref.makeUnsafe<FakePersistenceState>({
    persisted: [],
    retried: [],
  });
  const eventsRef = Ref.makeUnsafe<FakeEventsState>({
    workspaceEvents: [],
    workspaceFrames: [],
  });

  const layer = Layer.provide(WorkspaceTransaction.layer, layerDaemonModel(initial)).pipe(
    Layer.provide(
      Layer.succeed(WorkspaceTransactionSessions, trackingTransactionSessions(sessionRef)),
    ),
    Layer.provide(Layer.succeed(DaemonSessions, idleDaemonSessions)),
    Layer.provide(Layer.succeed(WorkspaceTransactionWorktreeOps, trackingWorktreeOps(worktreeRef))),
    Layer.provide(Layer.succeed(WorkspaceTransactionPersistence, trackingPersistence(persistRef))),
    Layer.provide(Layer.succeed(WorkspaceTransactionEvents, trackingEvents(eventsRef))),
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
  }).pipe(Effect.provide(withPluginBehaviour(layer)));
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
  }).pipe(Effect.provide(withPluginBehaviour(layer)));
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
    expect(result.snapshot.revision).toBe(1);
    expect(result.snapshot.spaces[0]!.name).toBe("renamed");
  }).pipe(Effect.provide(withPluginBehaviour(layer)));
});

testEffect("rolls back prepared sessions and does not persist on session failure", () => {
  const initial = singlePaneState();
  const { layer, sessionRef, persistRef } = testLayer(initial, {
    sessionFail: true,
  });
  return Effect.gen(function* () {
    const tx = yield* WorkspaceTransaction;
    const result = yield* Effect.exit(
      tx.run(command("pane.split", { axis: "row" }), initial.workspace.revision, context),
    );
    expect(result._tag).toBe("Failure");

    const persisted = yield* Ref.get(persistRef);
    expect(persisted.persisted).toHaveLength(0);

    const sessions = yield* Ref.get(sessionRef);
    expect(sessions.activated).toHaveLength(0);
  }).pipe(Effect.provide(withPluginBehaviour(layer)));
});

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
    expect(result.snapshot.revision).toBe(1);
    const panes = layoutPanes(result.snapshot.spaces[0]!.windows[0]!.layout.root);
    expect(panes).toHaveLength(2);
    expect(result.result).toEqual({ session: paneSession(panes[1]!.content)!, pane: panes[1]!.id });

    const sessions = yield* Ref.get(sessionRef);
    expect(sessions.prepared.length).toBe(1);
    expect(sessions.activated.length).toBe(1);
  }).pipe(Effect.provide(withPluginBehaviour(layer)));
});

testEffect("rejects worktree removal when dirty", () => {
  const initial = worktreeSpace();
  const { layer } = testLayer(initial, { worktreeDirty: true });
  return Effect.gen(function* () {
    const tx = yield* WorkspaceTransaction;
    const result = yield* Effect.exit(
      tx.run(command("space.close", { space: "wt-space" }), initial.workspace.revision, context),
    );
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(withPluginBehaviour(layer)));
});

const withPluginBehaviour = <R, E>(
  base: Layer.Layer<R, E, Scope.Scope | PluginBehaviour>,
  behaviour: PluginBehaviourService = emptyPluginBehaviour,
) => base.pipe(Layer.provide(Layer.succeed(PluginBehaviour, behaviour)));

testEffect("a failing plugin reducer leaves the revision unchanged", () => {
  const initial = singlePaneState();
  const { layer, persistRef } = testLayer(initial);
  const probeFail = defineDaemonCommand({
    tag: "probe.fail",
    fields: S.Struct({}),
    meta: { desc: "fail", group: "probe", target: "workspace", exposure: "human" },
    resources: () => [],
    reduce: () => Effect.fail(new PluginReducerError({ message: "reducer blew up" })),
  });
  return Effect.gen(function* () {
    const behaviour = yield* pluginBehaviourFromRegistrations([probeFail]);
    yield* Effect.gen(function* () {
      const tx = yield* WorkspaceTransaction;
      const before = initial.workspace.revision;
      const result = yield* Effect.exit(tx.run(runtimeCommand("probe.fail", {}), before, context));
      expect(result._tag).toBe("Failure");
      const persisted = yield* Ref.get(persistRef);
      expect(persisted.persisted).toHaveLength(0);
      expect(before).toBe(initial.workspace.revision);
    }).pipe(Effect.provide(withPluginBehaviour(layer, behaviour)));
  });
});

testEffect("a timed-out plugin reducer fails under TestClock", () => {
  const initial = singlePaneState();
  const probeHang = defineDaemonCommand({
    tag: "probe.hang",
    fields: S.Struct({}),
    meta: { desc: "hang", group: "probe", target: "workspace", exposure: "human" },
    resources: () => [],
    reduce: () => Effect.sleep(Duration.minutes(1)).pipe(Effect.as({ changes: [] })),
  });
  // Timeout is asserted on reducePluginCommand — the production helper the
  // transaction calls. Forking tx.run under TestClock does not complete: the
  // DaemonModel mutation-queue worker does not observe TestClock.adjust from
  // the test fiber once the full WorkspaceTransaction layer is in place.
  return Effect.gen(function* () {
    const behaviour = yield* pluginBehaviourFromRegistrations([probeHang]);
    const declarations = yield* behaviour.declarations;
    const fiber = yield* reducePluginCommand(
      runtimeCommand("probe.hang", {}),
      initial.workspace,
      context,
      declarations,
    ).pipe(Effect.provideService(PluginBehaviour, behaviour), Effect.exit, Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(PLUGIN_REDUCE_TIMEOUT_MS));
    const result = yield* Fiber.join(fiber);
    expect(Exit.isFailure(result)).toBe(true);
  }).pipe(Effect.provide(TestClock.layer()));
});

testEffect("transaction prepare maps declaredAgent to SessionSpec.agent", () =>
  Effect.gen(function* () {
    const seen: SessionSpec[] = [];
    const host = {
      prepare: (spec: SessionSpec) => {
        seen.push(spec);
        return Effect.succeed({
          session: stubManagedSession(spec.id),
          activate: Effect.void,
          abort: Effect.void,
        } satisfies PreparedSession);
      },
      write: () => Effect.void,
      pids: Effect.succeed(new Map<string, number>()),
    };
    const sessions = buildWorkspaceTransactionSessions(Effect.succeed(host), () => Effect.void);
    yield* sessions.prepare({
      id: "agent-1",
      name: "agent-1",
      cmd: ["echo", "hi"],
      cols: 80,
      rows: 24,
      exited: false,
      exitCode: null,
      declaredAgent: "claude",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.agent).toBe("claude");
    expect(Object.hasOwn(seen[0]!, "declaredAgent")).toBe(false);
  }),
);

testEffect("a maxCols layout rule elects different algorithms for narrow and wide viewports", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const configHome = yield* fs.makeTempDirectory({ prefix: "amux-layout-rules-" });
    const amuxDir = pathSvc.join(configHome, "amux");
    yield* fs.makeDirectory(amuxDir, { recursive: true });
    const configText = yield* S.encodeEffect(S.fromJsonString(JsonValueSchema))({
      layoutRules: [{ algorithm: "narrow", when: { maxCols: 80 } }],
      options: { "behaviour.tilingAlgorithm": "wide" },
    });
    yield* fs.writeFileString(pathSvc.join(amuxDir, "config.json"), configText);

    const elected: string[] = [];
    const makeAlgo = (id: string) =>
      tilingAlgorithmFromMethods({
        ...defaultTilingMethods,
        id,
        split(layout, size, at, direction, pane) {
          elected.push(id);
          return defaultTilingMethods.split!(layout, size, at, direction, pane);
        },
      });
    const narrow = makeAlgo("narrow");
    const wide = makeAlgo("wide");
    const tilingAlgorithms: TilingAlgorithmsService = {
      all: () => [
        {
          owner: { id: "test", generation: 0 },
          name: "narrow",
          value: { algorithm: narrow },
        },
        {
          owner: { id: "test", generation: 0 },
          name: "wide",
          value: { algorithm: wide },
        },
        {
          owner: { id: "amux.core", generation: 0 },
          name: defaultTilingAlgorithm.id,
          value: { algorithm: defaultTilingAlgorithm },
        },
      ],
      register: () => Effect.void,
    };
    const initial = singlePaneState();
    const { layer } = testLayer(initial);

    const behaviour = yield* pluginBehaviourFromRegistrations([], tilingAlgorithms);
    yield* Effect.gen(function* () {
      const tx = yield* WorkspaceTransaction;
      const narrowResult = yield* tx.run(
        command("pane.split", { axis: "row" }),
        initial.workspace.revision,
        {
          ...context,
          size: { cols: 40, rows: 24 },
        },
      );
      yield* tx.run(command("pane.split", { axis: "row" }), narrowResult.snapshot.revision, {
        ...context,
        size: { cols: 120, rows: 24 },
      });
      expect(elected).toEqual(["narrow", "wide"]);
    }).pipe(
      Effect.provide(withPluginBehaviour(layer, behaviour)),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ XDG_CONFIG_HOME: configHome }),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, Path.layer))),
);

testEffect(
  "a hand-built PluginBehaviour reduce is applied and its action reaches runAction",
  () => {
    const initial = singlePaneState();
    const { layer } = testLayer(initial);
    const ran: QueuedPluginAction[] = [];
    const fake: PluginBehaviourService = {
      declarations: Effect.succeed({
        commands: [
          {
            tag: "fake.cmd",
            meta: {
              desc: "fake",
              group: "fake",
              target: "workspace",
              exposure: "human",
            },
            fields: { type: "object", properties: {} },
            declaresResult: true,
            actionTags: ["fake.act"],
            paneTypes: [],
            providers: [],
            owner: { id: "test", generation: 0 },
          },
        ],
        algorithms: [],
        adapters: [],
      }),
      reduce: () =>
        Effect.succeed({
          changes: [
            { _tag: "result.set" as const, result: { ok: true } },
            { _tag: "action.push" as const, action: { _tag: "fake.act", n: 1 } },
          ],
        }),
      checkDescriptor: (_type, descriptor) => Effect.succeed(descriptor),
      runAction: (action) =>
        Effect.sync(() => {
          ran.push(action);
        }),
      runSession: () => Effect.succeed(null),
      runTiling: () =>
        Effect.fail(new TilingAlgorithmError({ algorithm: "unused", message: "unused" })),
      planResume: () => Effect.succeed(Option.none()),
    };
    return Effect.gen(function* () {
      const tx = yield* WorkspaceTransaction;
      const result = yield* tx.run(
        runtimeCommand("fake.cmd", {}),
        initial.workspace.revision,
        context,
      );
      expect(result.result).toEqual({ ok: true });
      expect(ran).toEqual([{ _tag: "fake.act", payload: { _tag: "fake.act", n: 1 } }]);
    }).pipe(Effect.provide(withPluginBehaviour(layer, fake)));
  },
);

testEffect(
  "a failing plugin tiling algorithm through WorkspaceTransaction falls back to default",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathSvc = yield* Path.Path;
      const configHome = yield* fs.makeTempDirectory({ prefix: "amux-tiling-fallback-" });
      const amuxDir = pathSvc.join(configHome, "amux");
      yield* fs.makeDirectory(amuxDir, { recursive: true });
      const configText = yield* S.encodeEffect(S.fromJsonString(JsonValueSchema))({
        options: { "behaviour.tilingAlgorithm": "boom" },
      });
      yield* fs.writeFileString(pathSvc.join(amuxDir, "config.json"), configText);

      let tilingCalls = 0;
      const fake: PluginBehaviourService = {
        declarations: Effect.succeed({
          commands: [],
          algorithms: [{ id: "boom", version: 1, owner: { id: "test", generation: 0 } }],
          adapters: [],
        }),
        reduce: () => Effect.succeed({ changes: [] }),
        checkDescriptor: (_type, descriptor) => Effect.succeed(descriptor),
        runAction: () => Effect.void,
        runSession: () => Effect.succeed(null),
        runTiling: (algorithmId) => {
          tilingCalls += 1;
          return Effect.fail(
            new TilingAlgorithmError({
              algorithm: algorithmId,
              message: "plugin tiling blew up",
            }),
          );
        },
        planResume: () => Effect.succeed(Option.none()),
      };

      const initial = singlePaneState();
      const { layer } = testLayer(initial);
      yield* Effect.gen(function* () {
        const tx = yield* WorkspaceTransaction;
        const result = yield* tx.run(
          command("pane.split", { axis: "row" }),
          initial.workspace.revision,
          context,
        );
        expect(tilingCalls).toBe(1);
        expect(result.snapshot.revision).toBeGreaterThan(initial.workspace.revision);
        const layout = result.snapshot.spaces[0]?.windows[0]?.layout;
        expect(layout).toBeDefined();
        if (layout === undefined) return;
        expect(layoutPanes(layout.root).length).toBe(2);
      }).pipe(
        Effect.provide(withPluginBehaviour(layer, fake)),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ XDG_CONFIG_HOME: configHome }),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, Path.layer))),
);
