/**
 * The Effect <-> OpenTUI lifetime bridge.
 *
 * Two acquire/release primitives that make a Renderable or an FFI handle a
 * Scope-owned resource, so the Scope tree is the one lifetime authority — the
 * render tree becomes a rendering detail. Nothing about a node leaving the
 * tree, or a `destroySelf` cascade, drives teardown timing; closing a Scope
 * does, and closing it can be awaited.
 */

import { Effect, Scope } from "effect";
import type { Renderable } from "@opentui/core";

/** The minimal surface a Renderable is mounted into and removed from. Every
 *  container in the tree (BoxRenderable, the renderer root) already satisfies
 *  this — it's named for what acquireRenderable needs, not opentui's shape. */
export interface RenderableParent {
  add(child: Renderable): void;
  remove(child: Renderable): void;
}

/**
 * Construct a Renderable and destroy it when the scope closes.
 *
 * `Renderable.destroy()` already detaches itself from whatever parent it
 * currently has, so release needs no parent of its own — which is what lets
 * this cover both a resource whose parent is fixed for its whole life (pass
 * `parent`, mounted immediately: a divider, torn down and rebuilt fresh on
 * every layout change) and one that gets reparented by ordinary tree code
 * after construction (omit `parent`, mount it yourself: a pane, reused and
 * moved between boxes across rebuilds — capturing a parent at acquire time
 * would remove it from the wrong box on release).
 */
export function acquireRenderable<R extends Renderable>(
  make: () => R,
  parent?: RenderableParent,
): Effect.Effect<R, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const view = make();
      parent?.add(view);
      return view;
    }),
    (view) => Effect.sync(() => view.destroy()),
  );
}

/** Acquire one FFI handle, freed when the scope closes. */
export function acquireFfi<A>(
  acquire: () => A,
  free: (handle: A) => void,
): Effect.Effect<A, never, Scope.Scope> {
  return Effect.acquireRelease(Effect.sync(acquire), (handle) => Effect.sync(() => free(handle)));
}

/**
 * A real, joinable Scope for a resource that is constructed synchronously and
 * torn down through an Effect a caller can await — a pane or a divider, built
 * from inside a plain (non-Effect) tree-rebuild method, but released through
 * `release: Effect.Effect<void>` that a Scope-closing caller further up can
 * `yield*`. `Scope.makeUnsafe` is the synchronous constructor for exactly this
 * — it produces the same joinable Scope.Closeable `Scope.make` would, without
 * spinning up a fiber to do it.
 */
export function makeScope(): Scope.Closeable {
  return Scope.makeUnsafe();
}

/** Run one acquire effect synchronously into a scope made by `makeScope`. */
export function runInScope<A>(
  scope: Scope.Closeable,
  effect: Effect.Effect<A, never, Scope.Scope>,
): A {
  return Effect.runSync(Scope.provide(effect, scope));
}
