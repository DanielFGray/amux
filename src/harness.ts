/**
 * The renderer/space/window scaffold the domain tests share.
 *
 * Test-only, but not a `.test.ts` file: bun would collect it as a suite with no
 * tests in it.
 *
 * Six suites had built this by hand, two of them byte-identical down to the
 * comments. That is the kind of duplication that quietly drifts — the settle
 * delay below existed in two copies and not in the other four, so half the
 * suites tore a renderer down while PTY pumps were still reading from it.
 *
 * These harnesses run real PTYs and a real ghostty VT behind a real renderer.
 * Nothing is mocked, because what they assert is the domain: split trees,
 * agent lifecycle, and geometry that only exists once yoga has run a frame.
 */

import { BoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Context, Effect, Exit, Scope } from "effect";
import { SpaceSet, type Space } from "./space.ts";
import type { Window } from "./window.ts";
import { workspaceEnv, type WorkspaceEnv } from "./env.ts";

/**
 * Run one of the workspace's Effect-returning methods and hand back its value.
 *
 * Everything that starts or stops a process is an Effect now; everything that
 * moves rectangles around is still a plain call. This is the seam between the
 * two, and it is synchronous on purpose — a suite asserting on geometry reads
 * the same as it did before, with `run(...)` marking exactly the calls that
 * have a lifetime attached.
 *
 * Exported standalone as well as on the harness so a suite can adopt it with
 * one import rather than threading it through every destructuring.
 */
export const run = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect);

/**
 * Run a releasing method, which cannot be synchronous.
 *
 * Acquisition is sync — building an agent is a constructor and a scope entry.
 * RELEASE is not, and cannot be made so: `Agent.release` interrupts the pump
 * fiber before freeing the terminal under it, and interrupting a running fiber
 * means waiting for it to finish unwinding. That await is the entire point of
 * Phase 3 having made the pump a fiber; without it, teardown races a writer
 * that is mid-write into an FFI handle being freed.
 *
 * So `killAgent`, `closeWindow`, `remove`, `breakPane` and scope close are
 * awaited, and everything else stays a plain call.
 *
 * Scope close joins all fibers but does not guarantee ghostty's render
 * callbacks have retired — a pane renders straight out of its agent's terminal,
 * so the renderer must not be destroyed until those callbacks drain.
 */
export const runAsync = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

/**
 * A SpaceSet and the call that ends it, for suites that mount their own
 * renderer rather than taking the whole harness.
 *
 * They used to write `new SpaceSet(...)` and remember `disposeAll()` in a
 * cleanup hook. The scope is what remembers now; this keeps the two-line shape
 * those suites had.
 */
export function scopedSpaceSet(
  env: Context.Context<WorkspaceEnv>,
  host: BoxRenderable,
): { spaces: SpaceSet; dispose: () => Promise<void> } {
  const scope = Effect.runSync(Scope.make());
  const spaces = Effect.runSync(Scope.extend(SpaceSet.make(env, host), scope));
  return { spaces, dispose: () => runAsync(Scope.close(scope, Exit.void)) };
}

export interface Harness {
  t: TestRendererSetup;
  spaces: SpaceSet;
  space: Space;
  window: Window;
  /**
   * Run one frame.
   *
   * Geometry comes from yoga, which only runs on a frame — so directional
   * focus, divider placement, and anything else positional means nothing until
   * this has been awaited at least once.
   */
  layout: () => Promise<void>;
  /** The module-level `run`, on the harness for convenience. */
  run: <A>(effect: Effect.Effect<A>) => A;
  /**
   * Replace the mounted workspace with a fresh, empty one and return it.
   *
   * For restore: the new set takes over the screen the old one had, so
   * rebuilt windows get the same geometry as the originals rather than sharing
   * the frame with them. The old set is left intact but unmounted, so a
   * snapshot taken before the swap is still comparable against it — and both
   * are disposed together, on one renderer instead of two.
   */
  takeOver: () => SpaceSet;
  /** Kill the agents, let their pumps settle, then drop the renderer. */
  dispose: () => Promise<void>;
}

export interface HarnessOptions {
  width?: number;
  height?: number;
  shell?: string[];
  /**
   * Whether to seed the window with an agent. `false` leaves it empty; a string
   * names the first agent, which is how a test asserts on a name it chose.
   */
  init?: boolean | string;
  /**
   * Flex direction of the host box. Left unset by default because yoga's own
   * default is what most suites were written against, and forcing an axis here
   * silently moves every pane in them.
   */
  hostDirection?: "row" | "column";
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const t = await createTestRenderer({
    width: options.width ?? 80,
    height: options.height ?? 24,
  });
  const host = new BoxRenderable(t.renderer, {
    id: "pane-host",
    flexGrow: 1,
    ...(options.hostDirection ? { flexDirection: options.hostDirection } : {}),
  });
  t.renderer.root.add(host);

  const shell = options.shell ?? ["bash"];

  // One scope over the whole harness. Every SpaceSet it hands out is built in
  // here, so `dispose` closing it is what ends the PTYs — the suites no longer
  // reach for disposeAll, and a suite that forgets to dispose leaks nothing it
  // did not already leak through the renderer.
  const scope = Effect.runSync(Scope.make());
  const build = () =>
    Effect.runSync(
      Scope.extend(SpaceSet.make(workspaceEnv(t.renderer, { shell }), mounted), scope),
    );

  let mounted: BoxRenderable = host;
  let hosts = 0;
  const spaces = build();
  const space = run(spaces.create("proj", process.cwd()));
  const window = run(space.newWindow());
  if (options.init !== false) {
    run(window.init(typeof options.init === "string" ? options.init : undefined));
  }

  return {
    t,
    spaces,
    space,
    window,
    run,
    layout: () => t.renderOnce(),
    takeOver() {
      t.renderer.root.remove(mounted);
      mounted = new BoxRenderable(t.renderer, {
        id: `pane-host-${++hosts}`,
        flexGrow: 1,
        ...(options.hostDirection ? { flexDirection: options.hostDirection } : {}),
      });
      t.renderer.root.add(mounted);
      return build();
    },
    async dispose() {
      await runAsync(Scope.close(scope, Exit.void));
      // Scope close joins all fibers, but ghostty's render callbacks are not
      // gated by fiber lifetime — a pane draws from the terminal the pump was
      // reading. 50ms is enough for any in-flight render callback to retire.
      await Bun.sleep(50);
      t.renderer.destroy();
    },
  };
}
