/**
 * The projection scaffold the workspace tests share: one scoped Effect that
 * feeds a Layout through the production reconciler.
 *
 * Test-only, but not a `.test.ts` file: bun would collect it as a suite with no
 * tests in it.
 *
 * A test that wants a window calls `project(layout)` — the same path production
 * runs at boot (app.tsx projects a snapshot through `projectWorkspace`, which
 * ends in `Window.project`). There is no second route into a window, so a
 * projection bug fails a pane test instead of hiding behind a private setup.
 *
 * The fixture is an Effect scoped to the caller's Scope (the one `testEffect`
 * hands each test). Closing that scope releases the workspace, then drains the
 * render callbacks, then destroys the renderer — in that order, because the
 * finalizers run last-registered-first and the renderer finalizer is registered
 * first of all.
 *
 * Sessions a layout names default to tombstones (a process that already ended):
 * the panes get a real ghostty terminal, but nothing runs, so a layout meant to
 * stage geometry starts no processes and cannot race a shell prompt into the
 * frame mid-test. `opts.sessions` overrides a session spec by id — a lifetime
 * test that needs to observe a kill passes a live spec and a spy backend.
 *
 * @effect-diagnostics *:skip-file -- this file constructs the render-tree/PTY seam it documents above.
 */

import { BoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Context, Effect } from "effect";
import type * as Scope from "effect/Scope";
import { Backend, workspaceEnv } from "./env.ts";
import { projectWorkspace, SpaceSet, type Space } from "./space.ts";
import type { Window } from "./window.ts";
import type { SessionBackendFactory } from "./backend.ts";
import type { PaneView } from "./component-pane.tsx";
import { layoutSessions, windowState, type Layout } from "./layout.ts";
import type { PersistedSession } from "./session.ts";
import { commandName } from "./command-name.ts";
import { spaceSetState, spaceState } from "./space-model.ts";
import type { WorkspaceSnapshot } from "./workspace.ts";

/** Everything a test needs once a window is on screen, plus one frame. */
export interface Scene {
  t: TestRendererSetup;
  spaces: SpaceSet;
  space: Space;
  window: Window;
  renderOnce: () => Effect.Effect<void>;
  /** The workspace backend, for a test that re-projects a later model revision
   *  through `projectWorkspace` — the same entry production uses on each change. */
  backend: SessionBackendFactory;
}

/** A session the layout names, overridden from the tombstone default. Every
 *  field is optional; whatever is omitted falls back to the default a plain pty
 *  tombstone would have. Set `exited: false` to hold a live session backed by
 *  the workspace backend. */
export type SessionSpec = Partial<
  Pick<
    PersistedSession,
    "name" | "cmd" | "kind" | "declaredAgent" | "provider" | "cwd" | "exited" | "exitCode"
  >
>;

export interface ProjectOptions {
  width?: number;
  height?: number;
  shell?: string[];
  backend?: SessionBackendFactory;
  paneContent?: PaneView;
  /** Build the host the workspace mounts into, instead of the harness adding a
   *  full-size one. The builder receives the renderer setup, attaches its boxes
   *  to the renderer root, and returns the leaf host — how a test reproduces the
   *  app's own node nesting around the pane area. */
  host?: (t: TestRendererSetup) => BoxRenderable;
  /** Per-session overrides. An id not listed stays a tombstone. */
  sessions?: Record<string, SessionSpec>;
}

/**
 * Feed a layout through `Window.project` inside a scoped workspace, and return
 * the reconstructed scene.
 *
 * One space (named "proj", cwd the process dir) and one window (number 1) are
 * always built; the layout's pane refs name the sessions, each defaulting to a
 * tombstone unless `opts.sessions` says otherwise.
 */
export function project(
  layout: Layout,
  options: ProjectOptions = {},
): Effect.Effect<Scene, never, Scope.Scope> {
  return Effect.gen(function* () {
    const width = options.width ?? 80;
    const height = options.height ?? 24;
    const t: TestRendererSetup = yield* Effect.promise(() => createTestRenderer({ width, height }));

    // Registered first so it runs last: the renderer must not be destroyed until
    // every session — and the render callbacks firing out of their terminals —
    // has been released. Mirrors the ordering the old dispose() enforced, and
    // stays until Phase 2 makes render-tree teardown awaitable.
    yield* Effect.addFinalizer(() =>
      Effect.andThen(Effect.promise(() => Bun.sleep(50)), Effect.sync(() => t.renderer.destroy())),
    );

    const host = options.host
      ? options.host(t)
      : new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1, flexDirection: "column" });
    if (!options.host) t.renderer.root.add(host);

    const env = workspaceEnv(t.renderer, {
      shell: options.shell,
      backend: options.backend,
      paneContent: options.paneContent,
    });

    const spaces = yield* SpaceSet.make(env, host);
    const backend = Context.get(env, Backend);
    yield* projectWorkspace(spaces, snapshotOf(layout, options.sessions, width, height), backend);

    const space = spaces.active!;
    const window = space.active!;
    return {
      t,
      spaces,
      space,
      window,
      backend,
      renderOnce: () => Effect.promise(() => t.renderOnce()),
    };
  });
}

/**
 * Assemble the renderer-free value the reconciler owns, from one layout.
 *
 * Exported so a test that simulates a later model revision can feed the new
 * layout through the public `projectWorkspace`, exactly as production replays
 * each revision — rather than mutating the window through a path that no
 * longer exists in a client projection.
 */
export function snapshotOf(
  layout: Layout,
  sessions?: Record<string, SessionSpec>,
  cols = 80,
  rows = 24,
): WorkspaceSnapshot {
  const spec = (id: string): PersistedSession => {
    const cmd = sessions?.[id]?.cmd ?? ["true"];
    return {
      id,
      name: commandName(cmd),
      cmd,
      cols,
      rows,
      exited: true,
      exitCode: 0,
      ...sessions?.[id],
    };
  };
  return {
    revision: 1,
    state: { ...spaceSetState(), activeSpace: "space-proj" },
    spaces: [
      {
        id: "space-proj",
        name: "proj",
        dir: process.cwd(),
        state: { ...spaceState(), activeWindow: 1 },
        windows: [
          {
            number: 1,
            name: null,
            state: { ...windowState(), focus: layout.focus ?? null },
            layout,
            sessions: layoutSessions(layout).map(spec),
          },
        ],
      },
    ],
  };
}
