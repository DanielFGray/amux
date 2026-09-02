import type { Layer } from "effect";
import { ManagedRuntime } from "effect";
import { onCleanup } from "solid-js";

/**
 * Build a `ManagedRuntime` scoped to the current Solid owner: the runtime,
 * and every service's finalizer in `layer`, disposes when the owning
 * computation cleans up (component unmount, resource teardown).
 *
 * Pass `parent` to share its `MemoMap`: layers common to both runtimes are
 * built once and refcounted by Effect itself, so a service used by both an
 * ancestor and a descendant runtime is finalized only when the last runtime
 * holding it disposes.
 */
export function createRuntime<R>(
  layer: Layer.Layer<R>,
  parent?: ManagedRuntime.ManagedRuntime<any, never>,
): ManagedRuntime.ManagedRuntime<R, never> {
  const runtime = ManagedRuntime.make(layer, parent && { memoMap: parent.memoMap });
  onCleanup(() => void runtime.dispose());
  return runtime;
}
