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
import { SpaceSet, type Space } from "./space.ts";
import type { Window } from "./window.ts";
import { workspaceEnv } from "./env.ts"

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
  const spaces = new SpaceSet(workspaceEnv(t.renderer, { shell }), host);
  const space = spaces.create("proj", process.cwd());
  const window = space.newWindow();
  if (options.init !== false) {
    window.init(typeof options.init === "string" ? options.init : undefined);
  }

  const all: SpaceSet[] = [spaces];
  let mounted: BoxRenderable = host;

  return {
    t,
    spaces,
    space,
    window,
    layout: () => t.renderOnce(),
    takeOver() {
      t.renderer.root.remove(mounted);
      mounted = new BoxRenderable(t.renderer, {
        id: `pane-host-${all.length}`,
        flexGrow: 1,
        ...(options.hostDirection ? { flexDirection: options.hostDirection } : {}),
      });
      t.renderer.root.add(mounted);
      const next = new SpaceSet(workspaceEnv(t.renderer, { shell }), mounted);
      all.push(next);
      return next;
    },
    async dispose() {
      for (const set of all) set.disposeAll();
      // A pane renders straight out of its agent's terminal, so the renderer
      // must not go while a pump is still mid-read — that is a use-after-free
      // into ghostty rather than an exception.
      await Bun.sleep(50);
      t.renderer.destroy();
    },
  };
}
