/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/**
 * The scope chain actually releases.
 *
 * Phase 5b (ts-95af71) made SpaceSet, Space and Window scoped, so closing one
 * scope at the top is what ends every PTY underneath. Nothing asserted that.
 * The rest of the suite is about geometry and layout, and it passes just as
 * happily when teardown is a no-op — verified by mutation: deleting the release
 * loop from `SpaceSet.release` left all 339 tests green.
 *
 * These tests hold the chain to its promise at each link, with a backend that
 * records being killed rather than by inspecting processes: the property under
 * test is "the finalizer ran", and a spy says that directly.
 */
import { test, expect } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { createApp } from "./app.tsx";
import { DEFAULT_CONFIG } from "./config.ts";
import { project, type SessionSpec } from "./harness.ts";
import { makeLayout, windowState, type Layout } from "./layout.ts";
import { spaceSetState, spaceState } from "./space-model.ts";
import type { SessionBackendFactory } from "./backend.ts";
import type { SessionClientContract } from "./client.ts";
import type { WorkspaceSnapshot } from "./workspace.ts";
import type { PersistedSession } from "./session.ts";
import { projectWorkspace } from "./space.ts";
import { testEffect } from "./test-effect.ts";

const { live } = testEffect(Layer.empty);

/**
 * A backend that starts nothing and remembers WHICH agents were killed.
 *
 * By id, not by count. A count cannot tell "killed the agent you asked for"
 * from "killed a different one instead" — and that is a real mutation: making
 * `killSession` release every session in the window still leaves the count at one
 * once the target has already been spliced out of the list.
 */
type SpyBackend = {
  backend: SessionBackendFactory;
  killed: () => string[];
};

function spyBackend(): SpyBackend {
  const killed: string[] = [];
  const backend: SessionBackendFactory = (opts) => {
    // Per instance, not shared: `closed` describes THIS backend, while the
    // counter above is how many of them the release chain reached.
    let mine = false;
    return {
      // Never ends on its own, so a killed backend is the only way the agent's
      // pump fiber stops — which is what makes the interrupt observable.
      stream: Stream.never,
      write() {},
      resize() {},
      close() {
        if (mine) return;
        mine = true;
        killed.push(opts.id);
      },
      kill() {
        this.close();
      },
      get closed() {
        return mine;
      },
      detached: false,
      exitCode: null,
      foregroundPgid: () => -1,
      sessionId: () => -1,
    };
  };
  return { backend, killed: () => killed };
}

/** A live, never-exiting session, backed by whatever the workspace env holds. */
const liveSpec = (): SessionSpec => ({ exited: false, cmd: ["sleep", "30"] });

const pane = (id: string, session: string) => ({
  type: "pane" as const,
  id,
  content: { kind: "pty" as const, session },
  weight: 1,
});

const liveSession = (id: string): PersistedSession => ({
  id,
  name: id,
  cmd: ["sleep", "30"],
  cols: 80,
  rows: 24,
  exited: false,
  exitCode: null,
});

/** A whole workspace as one space holding the given windows, for replaying a
 *  later model revision through `projectWorkspace` — which is how the daemon's
 *  next generation reaches the client. `pane` ids are what the reconcile uses to
 *  carry a pane (and its session scope) between windows. */
const revision = (
  ...windows: Array<{ number: number; layout: Layout; sessions: string[] }>
): WorkspaceSnapshot => ({
  revision: 1,
  state: { ...spaceSetState(), activeSpace: "space-proj" },
  spaces: [
    {
      id: "space-proj",
      name: "proj",
      dir: process.cwd(),
      state: { ...spaceState(), activeWindow: 1 },
      windows: windows.map((w) => ({
        number: w.number,
        name: null,
        state: { ...windowState(), focus: w.layout.focus ?? null },
        layout: w.layout,
        sessions: w.sessions.map(liveSession),
      })),
    },
  ],
});

live("closing the top scope kills agents three levels down", () =>
  Effect.gen(function* () {
    const spy = spyBackend();
    const scope = yield* Scope.make();
    const scene = yield* Scope.provide(
      project(
        makeLayout({
          root: {
            type: "split",
            direction: "row",
            weight: 1,
            children: [pane("p-first", "first"), pane("p-second", "second")],
          },
        }),
        { backend: spy.backend, sessions: { first: liveSpec(), second: liveSpec() } },
      ),
      scope,
    );
    const first = scene.window.panes[0]!.session!;
    const second = scene.window.panes[1]!.session!;
    expect(spy.killed()).toEqual([]);

    yield* Scope.close(scope, Exit.void);
    // Both agents, reached through SpaceSet -> Space -> Window without anyone
    // calling a dispose method by hand.
    expect(spy.killed().sort()).toEqual([first.id, second.id].sort());
  }),
);

live("closing one window releases its agents and leaves its siblings running", () =>
  Effect.gen(function* () {
    const spy = spyBackend();
    const scene = yield* project(
      makeLayout({
        root: {
          type: "pane",
          id: "p-doomed",
          content: { kind: "pty", session: "doomed" },
          weight: 1,
        },
        focus: "p-doomed",
      }),
      { backend: spy.backend, sessions: { doomed: liveSpec() } },
    );
    const doomed = scene.window.sessions[0]!;

    const survivorWindow = yield* scene.space.newWindow();
    const survivor = yield* survivorWindow.startSession({ cmd: ["sleep", "30"] });
    yield* survivorWindow.project(
      makeLayout({
        root: {
          type: "pane",
          id: "p-survivor",
          content: { kind: "pty", session: survivor.id },
          weight: 1,
        },
        focus: "p-survivor",
      }),
      { ...windowState(), focus: "p-survivor" },
    );

    yield* scene.space.closeWindow(scene.window);
    expect(spy.killed()).toEqual([doomed.id]);

    // The survivor is still live: closing the top scope is what ends it.
    yield* scene.space.closeWindow(survivorWindow);
    expect(spy.killed()).toEqual([doomed.id, survivor.id]);
  }),
);

live("dropping a session from the model releases it and no other", () =>
  Effect.gen(function* () {
    const spy = spyBackend();
    const scene = yield* project(
      makeLayout({
        root: {
          type: "split",
          direction: "row",
          weight: 1,
          children: [pane("p-bystander", "bystander"), pane("p-second", "second")],
        },
        focus: "p-bystander",
      }),
      { backend: spy.backend, sessions: { bystander: liveSpec(), second: liveSpec() } },
    );
    const window = scene.window;
    const bystander = window.sessions.find((s) => s.id === "bystander")!;
    const second = window.sessions.find((s) => s.id === "second")!;

    // The client never kills: the daemon removes the session from the model, and
    // the projection drops the pane that viewed it and releases its scope.
    yield* window.removeProjectedSession(second);

    // By id: the target, not merely "one of them". The splice happens before the
    // release, so a release loop over the survivors would kill the bystander and
    // still leave the count at one.
    expect(spy.killed()).toEqual([second.id]);
    expect(window.sessions).toContain(bystander);
  }),
);

// The lifetime property `space.breakPane` guaranteed: a pane moved to another
// window carries its session SCOPE with it, so closing the source window
// afterwards does not release the session. `breakPane` is gone, but the
// reconcile still must honour it — a pane id that reappears in a different
// window travels through releasePane/adopt, which is what moves the scope.
live("a pane moved to another window survives its source window closing", () =>
  Effect.gen(function* () {
    const spy = spyBackend();

    // Revision 1: one window holding "moved" beside "control".
    const scene = yield* project(
      makeLayout({
        root: {
          type: "split",
          direction: "row",
          weight: 1,
          children: [pane("p-moved", "moved"), pane("p-control", "control")],
        },
        focus: "p-control",
      }),
      { backend: spy.backend, sessions: { moved: liveSpec(), control: liveSpec() } },
    );
    expect(spy.killed()).toEqual([]);

    // Revision 2: break-pane in model terms — the same pane id now lives in a
    // second window. The handoff must carry its session scope.
    yield* projectWorkspace(
      scene.spaces,
      revision(
        {
          number: 1,
          layout: makeLayout({ root: pane("p-control", "control"), focus: "p-control" }),
          sessions: ["control"],
        },
        {
          number: 2,
          layout: makeLayout({ root: pane("p-moved", "moved"), focus: "p-moved" }),
          sessions: ["moved"],
        },
      ),
      scene.backend,
    );
    expect(spy.killed()).toEqual([]);

    // Revision 3: the source window is gone. Its control session is released;
    // the moved session's scope already travelled, so it stays live.
    yield* projectWorkspace(
      scene.spaces,
      revision({
        number: 2,
        layout: makeLayout({ root: pane("p-moved", "moved"), focus: "p-moved" }),
        sessions: ["moved"],
      }),
      scene.backend,
    );
    expect(spy.killed()).toEqual(["control"]);

    // And it is genuinely owned by its new window: closing that window is what
    // finally ends it.
    const survivor = scene.spaces.active!.windows.find((w) => w.number === 2)!;
    yield* scene.space.closeWindow(survivor);
    expect(spy.killed()).toEqual(["control", "moved"]);
  }),
);

test("scoped app release detaches daemon projections and terminates local owners", async () => {
  for (const ownership of ["daemon", "local"] as const) {
    const t = await createTestRenderer({ width: 60, height: 20 });
    const host = new BoxRenderable(t.renderer, {
      id: `pane-host-${ownership}`,
      flexGrow: 1,
    });
    const closed: string[] = [];
    const killed: string[] = [];
    const backend: SessionBackendFactory = (opts) => {
      let isClosed = false;
      return {
        stream: Stream.never,
        write() {},
        resize() {},
        close() {
          if (isClosed) return;
          isClosed = true;
          closed.push(opts.id);
          if (ownership === "local") killed.push(opts.id);
        },
        kill() {
          if (!isClosed) killed.push(opts.id);
          isClosed = true;
        },
        get closed() {
          return isClosed;
        },
        get detached() {
          return ownership === "daemon" && isClosed;
        },
        exitCode: null,
        foregroundPgid: () => -1,
        sessionId: () => -1,
      };
    };
    const workspace = lifecycleWorkspace(`agent-${ownership}`);
    const session = lifecycleSession(workspace, backend);
    const scope = Scope.makeUnsafe();

    try {
      // Starting the app reads its plugins off disk, so this is not synchronous.
      await Effect.runPromise(
        Scope.provide(
          createApp({
            renderer: t.renderer,
            paneHost: host,
            config: {
              ...structuredClone(DEFAULT_CONFIG),
              options: { "sidebar.open": false },
            },
            session,
            quit() {},
          }),
          scope,
        ),
      );
      expect(host.getChildren()).toHaveLength(1);

      await Effect.runPromise(Scope.close(scope, Exit.void));

      expect(closed).toEqual([`agent-${ownership}`]);
      expect(killed).toEqual(ownership === "local" ? [`agent-${ownership}`] : []);
      // The terminal is freed only after its entire renderable window has been
      // removed. A subsequent frame therefore has no path back to that handle.
      expect(host.getChildren()).toHaveLength(0);
      await t.renderOnce();
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      t.renderer.destroy();
    }
  }
});

function lifecycleWorkspace(agent: string): WorkspaceSnapshot {
  const pane = `pane-${agent}`;
  const layout = makeLayout({
    root: { type: "pane", id: pane, content: { kind: "pty", session: agent }, weight: 1 },
    focus: pane,
  });
  return {
    revision: 1,
    state: { ...spaceSetState(), activeSpace: "space-lifecycle" },
    spaces: [
      {
        id: "space-lifecycle",
        name: "lifecycle",
        dir: process.cwd(),
        state: { ...spaceState(), activeWindow: 1 },
        windows: [
          {
            number: 1,
            name: null,
            state: { ...windowState(), focus: pane },
            layout,
            sessions: [
              {
                id: agent,
                name: agent,
                cmd: ["sleep", "30"],
                cols: 40,
                rows: 10,
                exited: false,
                exitCode: null,
              },
            ],
          },
        ],
      },
    ],
  };
}

function lifecycleSession(
  workspace: WorkspaceSnapshot,
  spawn: SessionBackendFactory,
): SessionClientContract {
  return {
    id: "lifecycle",
    session: null,
    live: new Set(
      workspace.spaces.flatMap((space) =>
        space.windows.flatMap((window) => window.sessions.map((agent) => agent.id)),
      ),
    ),
    workspace: () => structuredClone(workspace),
    models: Stream.never,
    events: Stream.never,
    commandRequests: Stream.never,
    respondCommand: () => {},
    backend: () => spawn,
    runWorkspace: () => Effect.succeed({ snapshot: structuredClone(workspace) }),
    resumeAgent: () => Effect.void,
    run: () => Effect.void,
    close() {},
    stop: Effect.void,
    setBuffer: () => Effect.succeed("buffer"),
    pasteBuffer: () => Effect.void,
    listBuffers: Effect.succeed([]),
    deleteBuffer: () => Effect.void,
    showBuffer: () => Effect.succeed(""),
    documentOpen: () =>
      Effect.succeed({
        uri: "",
        generation: 1,
        dirty: false,
        lineCount: 1,
        byteLength: 0,
        charCount: 0,
        refs: 1,
      }),
    documentApply: () =>
      Effect.succeed({
        uri: "",
        generation: 2,
        dirty: true,
        lineCount: 1,
        byteLength: 0,
        charCount: 0,
        refs: 1,
      }),
    documentWrite: () =>
      Effect.succeed({
        uri: "",
        generation: 2,
        dirty: true,
        lineCount: 1,
        byteLength: 0,
        charCount: 0,
        refs: 1,
      }),
    documentSnapshot: () =>
      Effect.succeed({
        uri: "",
        generation: 1,
        dirty: false,
        lineCount: 1,
        byteLength: 0,
        charCount: 0,
        refs: 1,
        text: "",
      }),
    documentSlice: () => Effect.succeed([]),
    documentSave: () =>
      Effect.succeed({
        uri: "",
        generation: 1,
        dirty: false,
        lineCount: 1,
        byteLength: 0,
        charCount: 0,
        refs: 1,
      }),
    documentClose: () => Effect.void,
    documentList: Effect.succeed([]),
    attach: {} as SessionClientContract["attach"],
  };
}
