import { expect, test } from "bun:test";
import { Duration, Effect, Exit, Fiber, Logger, Schema as S } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { command } from "./commands.ts";
import { nodePath } from "./effect/node-path.ts";
import { encodeLayout, layoutPanes, makeLayout } from "./layout.ts";
import {
  invokeTilingAlgorithm,
  tilingAlgorithmFromMethods,
  type TilingAlgorithmMethods,
} from "./tiling-algorithm.ts";
import { defaultTilingAlgorithm, defaultTilingMethods } from "./tiling-algorithm-default.ts";
import {
  TilingAnswerSchema,
  TilingOperationSchema,
  type TilingOperation,
} from "./tiling-operation.ts";
import { PLUGIN_TILING_TIMEOUT_MS } from "./workspace-changes.ts";
import {
  applyWorkspaceCommand,
  workspaceFromSession,
  type WorkspaceCommandContext,
  type WorkspaceSnapshot,
} from "./workspace.ts";
import { niriTilingMethods } from "../../plugin-niri/src/niri.ts";
import type { SessionState } from "./session.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const path = run(nodePath);
const context: WorkspaceCommandContext = {
  size: { cols: 80, rows: 24 },
  shell: ["sh"],
  cwd: "/tmp",
};

const singlePaneLayout = encodeLayout(
  makeLayout({
    root: {
      type: "pane",
      id: "pane-a",
      content: { kind: "pty", session: "agent-a" },
      weight: 1,
    },
    focus: "pane-a",
  }),
);

const paneBase = (layout = singlePaneLayout): SessionState => ({
  version: 1,
  id: "model",
  createdAt: 1,
  updatedAt: 1,
  attached: false,
  activeSpace: "space-a",
  spaces: [
    {
      id: "space-a",
      name: "project",
      dir: "/tmp",
      activeWindow: 1,
      windows: [
        {
          number: 1,
          name: null,
          sessions: [
            {
              id: "agent-a",
              name: "cat",
              cmd: ["cat"],
              cols: 80,
              rows: 24,
              exited: false,
              exitCode: null,
            },
          ],
          layout,
        },
      ],
    },
  ],
});

const apply = (
  workspace: WorkspaceSnapshot,
  cmd: ReturnType<typeof command>,
  algorithm = defaultTilingAlgorithm,
) => run(applyWorkspaceCommand(workspace, cmd, context, path, undefined, algorithm));

const withCollectingLogger = <A, E>(effect: Effect.Effect<A, E>, sink: string[]) =>
  effect.pipe(
    Effect.withLogger(
      Logger.make(({ message }) => {
        const text = Array.isArray(message)
          ? message.map(String).join(" ")
          : typeof message === "string"
            ? message
            : String(message);
        sink.push(text);
      }),
    ),
  );

test("a failing plugin algorithm falls back to the default result and warns", () => {
  let workspace = run(workspaceFromSession(paneBase()));
  workspace = apply(workspace, command("pane.split", { axis: "row" })).snapshot;

  const failing = tilingAlgorithmFromMethods({
    ...defaultTilingMethods,
    id: "failing",
    split() {
      throw new Error("plugin split exploded");
    },
  });

  const logs: string[] = [];
  const withFailing = run(
    withCollectingLogger(
      applyWorkspaceCommand(
        workspace,
        command("pane.split", { axis: "row" }),
        context,
        path,
        undefined,
        failing,
      ),
      logs,
    ),
  );
  const withDefault = apply(workspace, command("pane.split", { axis: "row" }));

  expect(layoutPanes(withFailing.snapshot.spaces[0]!.windows[0]!.layout.root).length).toBe(
    layoutPanes(withDefault.snapshot.spaces[0]!.windows[0]!.layout.root).length,
  );
  expect(logs.some((line) => line.includes("failing") && line.includes("pane.split"))).toBe(true);
});

test("invokeTilingAlgorithm times out under TestClock", () =>
  Effect.gen(function* () {
    const slow = {
      id: "hanging",
      version: 1,
      run: () =>
        Effect.sleep(Duration.minutes(1)).pipe(Effect.as({ _tag: "unsupported" as const })),
    };
    const fiber = yield* invokeTilingAlgorithm(slow, {
      _tag: "close",
      layout: makeLayout({ root: null }),
      size: { cols: 80, rows: 24 },
      pane: "x",
    }).pipe(Effect.exit, Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(PLUGIN_TILING_TIMEOUT_MS));
    const result = yield* Fiber.join(fiber);
    expect(Exit.isFailure(result)).toBe(true);
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise));

test("a plugin algorithm that never answers falls back after the time limit", () =>
  Effect.gen(function* () {
    let workspace = yield* workspaceFromSession(paneBase());
    workspace = (yield* applyWorkspaceCommand(
      workspace,
      command("pane.split", { axis: "row" }),
      context,
      path,
    )).snapshot;

    const hanging = {
      id: "hanging",
      version: 1,
      run: () =>
        Effect.sleep(Duration.minutes(1)).pipe(Effect.as({ _tag: "unsupported" as const })),
    };

    const logs: string[] = [];
    const fiber = yield* withCollectingLogger(
      applyWorkspaceCommand(
        workspace,
        command("pane.split", { axis: "row" }),
        context,
        path,
        undefined,
        hanging,
      ),
      logs,
    ).pipe(Effect.exit, Effect.forkChild);

    yield* TestClock.adjust(Duration.millis(PLUGIN_TILING_TIMEOUT_MS));
    const result = yield* Fiber.join(fiber);
    expect(Exit.isSuccess(result)).toBe(true);
    const expected = yield* applyWorkspaceCommand(
      workspace,
      command("pane.split", { axis: "row" }),
      context,
      path,
    );
    if (Exit.isSuccess(result)) {
      expect(layoutPanes(result.value.snapshot.spaces[0]!.windows[0]!.layout.root).length).toBe(
        layoutPanes(expected.snapshot.spaces[0]!.windows[0]!.layout.root).length,
      );
    }
    expect(logs.some((line) => line.includes("hanging") && line.includes("pane.split"))).toBe(true);
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise));

test("an unsupported operation falls through to the core layout fallback", () => {
  let workspace = run(workspaceFromSession(paneBase()));
  workspace = apply(workspace, command("pane.split", { axis: "row" })).snapshot;

  const methods: TilingAlgorithmMethods = {
    id: "partial",
    version: 1,
    init: defaultTilingMethods.init,
    close: defaultTilingMethods.close,
    focusInDirection: defaultTilingMethods.focusInDirection,
  };
  const partial = tilingAlgorithmFromMethods(methods);

  const viaPartial = apply(workspace, command("pane.split", { axis: "row" }), partial);
  const viaDefault = apply(workspace, command("pane.split", { axis: "row" }));
  expect(layoutPanes(viaPartial.snapshot.spaces[0]!.windows[0]!.layout.root).length).toBe(
    layoutPanes(viaDefault.snapshot.spaces[0]!.windows[0]!.layout.root).length,
  );
});

test("default close on a niri scroll layout fails when a column would drop", () => {
  const size = { cols: 80, rows: 24 };
  const scroll = niriTilingMethods.init(
    [
      { id: "pane-a", content: { kind: "pty", session: "agent-a" } },
      { id: "pane-b", content: { kind: "pty", session: "agent-b" } },
    ],
    size,
  );
  const state = paneBase(encodeLayout(scroll));
  state.spaces[0]!.windows[0]!.sessions.push({
    id: "agent-b",
    name: "cat",
    cmd: ["cat"],
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null,
  });

  const workspace = run(workspaceFromSession(state));
  const exit = Effect.runSyncExit(
    applyWorkspaceCommand(
      workspace,
      command("pane.close"),
      context,
      path,
      undefined,
      defaultTilingAlgorithm,
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const message = String(exit.cause);
    expect(message).toMatch(/foreign layout kind 'scroll'/);
  }
});

test("tiling operation and answer Schemas round-trip every operation", () => {
  const size = { cols: 80, rows: 24 };
  const layout = defaultTilingMethods.init(
    [
      { id: "a", content: { kind: "pty", session: "a" } },
      { id: "b", content: { kind: "pty", session: "b" } },
    ],
    size,
  );
  const pane = { id: "c", content: { kind: "pty" as const, session: "c" } };
  const operations: TilingOperation[] = [
    { _tag: "init", panes: [{ id: "a", content: { kind: "pty", session: "a" } }], size },
    { _tag: "close", layout, size, pane: "a" },
    { _tag: "focusDirection", layout, size, from: "a", direction: "right" },
    { _tag: "reveal", layout, size, pane: "b" },
    { _tag: "split", layout, size, at: "a", direction: "row", pane },
    { _tag: "swap", layout, size, from: "a", step: 1 },
    { _tag: "preset", layout, size, preset: "tiled" },
    { _tag: "resizeFocus", layout, size, pane: "a", direction: "right", delta: 1 },
    { _tag: "resizeDivider", layout, size, path: [], index: 0, delta: 1 },
  ];
  for (const op of operations) {
    const encoded = run(S.encodeEffect(TilingOperationSchema)(op));
    const decoded = run(S.decodeEffect(TilingOperationSchema)(encoded));
    expect(decoded._tag).toBe(op._tag);
  }
  const answers = [
    { _tag: "ok" as const, layout, focus: "a" as string | null },
    { _tag: "ok" as const, layout },
    { _tag: "unsupported" as const },
  ];
  for (const answer of answers) {
    const encoded = run(S.encodeEffect(TilingAnswerSchema)(answer));
    const decoded = run(S.decodeEffect(TilingAnswerSchema)(encoded));
    expect(decoded._tag).toBe(answer._tag);
  }
});
