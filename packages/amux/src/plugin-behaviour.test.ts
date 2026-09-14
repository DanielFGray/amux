import { expect } from "bun:test";
import { Duration, Effect, Exit, Fiber, Layer, Queue, Schema as S, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { testEffect } from "./test-effect.ts";
import { toJsonSchemaDocument, type JsonSchemaDocumentError } from "./command-cli.ts";
import { runtimeCommand } from "./commands.ts";
import { defineDaemonCommand } from "./define-daemon-command.ts";
import { definePaneType } from "./pane-descriptors.ts";
import { definePluginAction } from "./effect/WorkspaceTransaction.ts";
import {
  PLUGIN_SESSION_RUN_TIMEOUT_MS,
  PluginBehaviour,
  PluginDeclarationsSchema,
  buildPluginBehaviour,
  runPluginSessionCommand,
} from "./plugin-behaviour.ts";
import {
  adapterLookupWith,
  emptyAdapterLookup,
  emptyAlgorithms,
  pluginBehaviourFromRegistrations,
  stubSessions,
} from "./test-plugin-behaviour.ts";
import { DaemonSessions, type DaemonSessionsService } from "./daemon-sessions.ts";
import {
  PLUGIN_DESCRIPTOR_CHECK_TIMEOUT_MS,
  PLUGIN_REDUCE_TIMEOUT_MS,
} from "./workspace-changes.ts";
import {
  buildWorkspaceReadPackage,
  workspaceFromSession,
  type WorkspaceCommandContext,
} from "./workspace.ts";
import type { SessionState } from "./session.ts";
import { makeLayout } from "./layout.ts";
import { editorDaemonCommands } from "../../editor/src/daemon.ts";
import { agentHarnessDaemonCommands } from "../../plugin-agent-harness/src/daemon.ts";
import { niriTilingAlgorithm } from "../../plugin-niri/src/niri.ts";
import { adapters as continuityAdapters } from "../../plugin-agent-continuity/src/adapters/index.ts";
import type {
  DaemonCommandRecord,
  DaemonCommandsService,
  TilingAlgorithmsService,
} from "./plugin/services.ts";
import { DaemonCommandsTag, registerDaemonCommand, scopedRegistry } from "./plugin/services.ts";
import { createPluginContributions } from "./plugin/contributions.ts";
import { createPluginHost } from "./plugin/host.ts";
import { definePlugin } from "./plugin/types.ts";
import { PluginActivateError } from "./plugin/activate-error.ts";

const { effect: testClockEffect } = testEffect(Layer.empty);

const context: WorkspaceCommandContext = {
  size: { cols: 80, rows: 24 },
  shell: ["sh"],
  cwd: "/tmp",
};

const baseState = (): SessionState => ({
  version: 1,
  id: "test",
  createdAt: 1,
  updatedAt: 1,
  attached: false,
  activeSpace: "space-1",
  spaces: [
    {
      id: "space-1",
      name: "main",
      dir: "/tmp",
      activeWindow: 1,
      windows: [
        {
          number: 1,
          name: null,
          sessions: [
            {
              id: "agent-1",
              name: "sh",
              cmd: ["echo"],
              cwd: "/tmp",
              cols: 80,
              rows: 24,
              exited: false,
              exitCode: null,
            },
          ],
          layout: JSON.stringify(
            makeLayout({
              root: {
                type: "pane",
                id: "pane-1",
                content: { kind: "pty", session: "agent-1" },
                weight: 1,
              },
              focus: "pane-1",
            }),
          ),
        },
      ],
    },
  ],
});

const idleSessions: DaemonSessionsService = {
  message: () => Effect.void,
  prompt: () => Effect.void,
  capture: () => Effect.succeed(""),
};

const mutableCommands = (
  initial: readonly DaemonCommandRecord[] = [],
): DaemonCommandsService & { replace: (next: readonly DaemonCommandRecord[]) => void } => {
  let list = [...initial];
  return {
    all: () =>
      list.map((value) => ({
        owner: { id: "test", generation: 0 },
        name: value.command.tag,
        value,
      })),
    register: () => Effect.void,
    replace: (next) => {
      list = [...next];
    },
  };
};

const recordOf = (
  command: DaemonCommandRecord["command"],
): Effect.Effect<DaemonCommandRecord, JsonSchemaDocumentError> =>
  toJsonSchemaDocument(command.fields).pipe(
    Effect.map((fields) => ({ command, fields }) satisfies DaemonCommandRecord),
  );

testEffect(
  "a plugin command reduces, checks a descriptor, runs an action and a session command through the service",
  () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const pane = definePaneType("probe.pane", S.Struct({ label: S.String }));
      const action = definePluginAction({
        tag: "probe.ping",
        payload: S.Struct({ n: S.Finite }),
        execute: (payload) =>
          Effect.sync(() => {
            seen.push(`action:${payload.n}`);
          }),
      });
      const workspaceCmd = defineDaemonCommand({
        tag: "probe.reduce",
        fields: S.Struct({ label: S.String }),
        meta: { desc: "reduce", group: "probe", target: "workspace", exposure: "human" },
        resources: () => [],
        paneTypes: [pane],
        actions: [action],
        reduce: ({ command, build }) =>
          Effect.gen(function* () {
            seen.push(`reduce:${command.label}`);
            return build.answer([
              yield* action.push({ n: 7 }),
              yield* pane.place({ mode: "replace", descriptor: { label: command.label } }),
            ]);
          }),
      });
      const sessionCmd = defineDaemonCommand({
        tag: "probe.session",
        fields: S.Struct({ target: S.String }),
        meta: { desc: "session", group: "probe", target: "session", exposure: "human" },
        resources: (args) => [args.target],
        run: (command) =>
          Effect.sync(() => {
            seen.push(`session:${command.target}`);
            return { ok: true, target: command.target };
          }),
      });
      const behaviour = yield* pluginBehaviourFromRegistrations([workspaceCmd, sessionCmd]);
      const workspace = yield* workspaceFromSession(baseState());
      const reads = buildWorkspaceReadPackage(workspace, context);

      const answer = yield* behaviour.reduce(
        runtimeCommand("probe.reduce", { label: "hi" }),
        context,
        reads,
      );
      expect(answer.changes.length).toBeGreaterThan(0);

      const checked = yield* behaviour.checkDescriptor("probe.pane", { label: "hi" });
      expect(checked).toEqual({ label: "hi" });

      yield* behaviour
        .runAction({ _tag: "probe.ping", payload: { n: 3 } })
        .pipe(Effect.provideService(DaemonSessions, idleSessions));

      const sessionResult = yield* behaviour
        .runSession(runtimeCommand("probe.session", { target: "agent-1" }), {
          snapshot: workspace,
        })
        .pipe(Effect.provideService(DaemonSessions, idleSessions));
      expect(sessionResult).toEqual({ ok: true, target: "agent-1" });
      expect(seen).toEqual(["reduce:hi", "action:3", "session:agent-1"]);
    }),
);

testEffect("declarations list editor.open, agent.* commands, niri, and continuity adapters", () =>
  Effect.gen(function* () {
    const table = adapterLookupWith(continuityAdapters);
    const algorithms: TilingAlgorithmsService = {
      all: () => [
        {
          owner: { id: "niri", generation: 0 },
          name: niriTilingAlgorithm.id,
          value: { algorithm: niriTilingAlgorithm },
        },
      ],
      register: () => Effect.void,
    };
    const behaviour = yield* pluginBehaviourFromRegistrations(
      [...editorDaemonCommands, ...agentHarnessDaemonCommands],
      algorithms,
      table,
    );
    const declarations = yield* behaviour.declarations;
    yield* S.decodeEffect(PluginDeclarationsSchema)(declarations);

    const tags = new Set(declarations.commands.map((entry) => entry.tag));
    expect(tags.has("editor.open")).toBe(true);
    expect(tags.has("agent.new")).toBe(true);
    expect(tags.has("agent.prompt")).toBe(true);
    expect(tags.has("agent.logs")).toBe(true);
    expect(declarations.algorithms.map((entry) => entry.id)).toContain("niri");
    const niri = declarations.algorithms.find((entry) => entry.id === "niri");
    expect(niri?.version).toBe(niriTilingAlgorithm.version);
    expect(declarations.adapters.map((entry) => entry.id).sort()).toEqual(
      ["claude", "codex", "cursor", "opencode"].sort(),
    );

    const editorOpen = editorDaemonCommands[0];
    const editor = declarations.commands.find((entry) => entry.tag === "editor.open");
    expect(editor).toBeDefined();
    expect(editorOpen).toBeDefined();
    if (editor === undefined || editorOpen === undefined) return;
    expect(editor.fields).toEqual(yield* toJsonSchemaDocument(editorOpen.fields));
    expect(editor.paneTypes).toContain("amux.editor");
  }),
);

testClockEffect("a session-target run that exceeds its time limit fails clearly", () =>
  Effect.gen(function* () {
    const hanging = defineDaemonCommand({
      tag: "probe.slow",
      fields: S.Struct({}),
      meta: { desc: "slow", group: "probe", target: "session", exposure: "human" },
      resources: () => [],
      run: () => Effect.sleep(Duration.minutes(1)).pipe(Effect.as({ ok: true })),
    });
    const behaviour = yield* pluginBehaviourFromRegistrations([hanging]);
    const workspace = yield* workspaceFromSession(baseState());
    const fiber = yield* runPluginSessionCommand(runtimeCommand("probe.slow", {}), {
      snapshot: workspace,
    }).pipe(
      Effect.provideService(PluginBehaviour, behaviour),
      Effect.provideService(DaemonSessions, idleSessions),
      Effect.exit,
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.millis(PLUGIN_SESSION_RUN_TIMEOUT_MS));
    const result = yield* Fiber.join(fiber);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(String(result.cause)).toContain("timed out after");
    }
  }),
);

testEffect("after a plugin reload, declarations show the new set", () =>
  Effect.gen(function* () {
    const first = defineDaemonCommand({
      tag: "probe.first",
      fields: S.Struct({}),
      meta: { desc: "first", group: "probe", target: "workspace", exposure: "human" },
      resources: () => [],
      reduce: () => Effect.succeed({ changes: [] }),
    });
    const second = defineDaemonCommand({
      tag: "probe.second",
      fields: S.Struct({ x: S.String }),
      meta: { desc: "second", group: "probe", target: "workspace", exposure: "human" },
      resources: () => [],
      reduce: () => Effect.succeed({ changes: [] }),
    });
    const commands = mutableCommands([yield* recordOf(first)]);
    const behaviour = buildPluginBehaviour(
      commands,
      emptyAlgorithms(),
      emptyAdapterLookup(),
      stubSessions,
    );
    const before = yield* behaviour.declarations;
    expect(before.commands.map((entry) => entry.tag)).toEqual(["probe.first"]);
    commands.replace([yield* recordOf(second)]);
    const after = yield* behaviour.declarations;
    expect(after.commands.map((entry) => entry.tag)).toEqual(["probe.second"]);
    expect(after.commands[0]?.fields).toEqual(yield* toJsonSchemaDocument(second.fields));
  }),
);

testEffect("two behaviours over different tables do not share declarations", () =>
  Effect.gen(function* () {
    const leftCmd = defineDaemonCommand({
      tag: "probe.left",
      fields: S.Struct({}),
      meta: { desc: "left", group: "probe", target: "workspace", exposure: "human" },
      resources: () => [],
      reduce: () => Effect.succeed({ changes: [] }),
    });
    const rightCmd = defineDaemonCommand({
      tag: "probe.right",
      fields: S.Struct({}),
      meta: { desc: "right", group: "probe", target: "workspace", exposure: "human" },
      resources: () => [],
      reduce: () => Effect.succeed({ changes: [] }),
    });
    const left = buildPluginBehaviour(
      mutableCommands([yield* recordOf(leftCmd)]),
      emptyAlgorithms(),
      emptyAdapterLookup(),
      stubSessions,
    );
    const right = buildPluginBehaviour(
      mutableCommands([yield* recordOf(rightCmd)]),
      emptyAlgorithms(),
      emptyAdapterLookup(),
      stubSessions,
    );
    expect((yield* left.declarations).commands.map((entry) => entry.tag)).toEqual(["probe.left"]);
    expect((yield* right.declarations).commands.map((entry) => entry.tag)).toEqual(["probe.right"]);
  }),
);

testClockEffect("reduce and descriptor check keep their call-site time limits", () =>
  Effect.gen(function* () {
    const hangReduce = defineDaemonCommand({
      tag: "probe.hang-reduce",
      fields: S.Struct({}),
      meta: { desc: "hang", group: "probe", target: "workspace", exposure: "human" },
      resources: () => [],
      reduce: () => Effect.sleep(Duration.minutes(1)).pipe(Effect.as({ changes: [] })),
    });
    const hangPane = definePaneType("probe.hang-pane", S.Struct({}));
    const hangCheck = defineDaemonCommand({
      tag: "probe.hang-check",
      fields: S.Struct({}),
      meta: { desc: "hang check", group: "probe", target: "workspace", exposure: "human" },
      resources: () => [],
      paneTypes: [
        {
          type: hangPane.type,
          check: () => Effect.sleep(Duration.minutes(1)).pipe(Effect.as({})),
        },
      ],
      reduce: () => Effect.succeed({ changes: [] }),
    });
    const behaviour = yield* pluginBehaviourFromRegistrations([hangReduce, hangCheck]);
    const workspace = yield* workspaceFromSession(baseState());
    const reads = buildWorkspaceReadPackage(workspace, context);

    const reduceFiber = yield* behaviour
      .reduce(runtimeCommand("probe.hang-reduce", {}), context, reads)
      .pipe(
        Effect.timeout(Duration.millis(PLUGIN_REDUCE_TIMEOUT_MS)),
        Effect.exit,
        Effect.forkChild,
      );
    yield* TestClock.adjust(Duration.millis(PLUGIN_REDUCE_TIMEOUT_MS));
    expect(Exit.isFailure(yield* Fiber.join(reduceFiber))).toBe(true);

    const checkFiber = yield* behaviour
      .checkDescriptor("probe.hang-pane", {})
      .pipe(
        Effect.timeout(Duration.millis(PLUGIN_DESCRIPTOR_CHECK_TIMEOUT_MS)),
        Effect.exit,
        Effect.forkChild,
      );
    yield* TestClock.adjust(Duration.millis(PLUGIN_DESCRIPTOR_CHECK_TIMEOUT_MS));
    expect(Exit.isFailure(yield* Fiber.join(checkFiber))).toBe(true);
  }),
);

testEffect(
  "a plugin whose fields fail JSON Schema conversion is refused at load; others stay",
  () =>
    Effect.gen(function* () {
      const contributions = createPluginContributions();
      const table = contributions.table<DaemonCommandRecord>();
      const daemonCommands = scopedRegistry(
        { all: table.all },
        (owner, record: DaemonCommandRecord) => table.add(owner, record.command.tag, record),
      );
      const behaviour = buildPluginBehaviour(
        daemonCommands,
        emptyAlgorithms(),
        emptyAdapterLookup(),
        stubSessions,
      );
      const host = yield* createPluginHost({ contributions });

      const good = defineDaemonCommand({
        tag: "probe.good",
        fields: S.Struct({ label: S.String }),
        meta: { desc: "good", group: "probe", target: "workspace", exposure: "human" },
        resources: () => [],
        reduce: () => Effect.succeed({ changes: [] }),
      });
      const bad = defineDaemonCommand({
        tag: "probe.bad",
        fields: S.Struct({ n: S.Literals([1, 2]) }),
        meta: { desc: "bad", group: "probe", target: "workspace", exposure: "human" },
        resources: () => [],
        reduce: () => Effect.succeed({ changes: [] }),
      });

      const errors = yield* Queue.unbounded<{ readonly pluginId: string; readonly error: Error }>();
      const drain = yield* host.onError.pipe(
        Stream.runForEach((event) =>
          Queue.offer(errors, { pluginId: event.pluginId, error: event.error }),
        ),
        Effect.forkDetach,
      );
      yield* Effect.yieldNow;

      yield* host.reconcile([
        definePlugin({
          id: "amux.registry.daemon-commands",
          provide: [DaemonCommandsTag],
          effect: (ctx) => Effect.sync(() => void ctx.provide(DaemonCommandsTag, daemonCommands)),
        }),
        definePlugin({
          id: "probe.good-plugin",
          inject: [DaemonCommandsTag],
          effect: () => registerDaemonCommand(good),
        }),
        definePlugin({
          id: "probe.bad-plugin",
          inject: [DaemonCommandsTag],
          effect: () => registerDaemonCommand(bad),
        }),
      ]);
      yield* Effect.yieldNow;

      const reported = yield* Queue.takeAll(errors);
      yield* Fiber.interrupt(drain);

      const badReport = reported.find((entry) => entry.pluginId === "probe.bad-plugin");
      expect(badReport).toBeDefined();
      expect(S.is(PluginActivateError)(badReport?.error)).toBe(true);
      expect(badReport?.error.message).toContain("not publishable as JSON Schema");
      expect(
        host
          .status()
          .map((status) => [status.id, status.phase] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ).toEqual([
        ["amux.registry.daemon-commands", "active"],
        ["probe.bad-plugin", "failed"],
        ["probe.good-plugin", "active"],
      ]);
      const declarations = yield* behaviour.declarations;
      expect(declarations.commands.map((entry) => entry.tag)).toEqual(["probe.good"]);
    }),
);
