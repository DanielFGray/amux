/**
 * `Path.Path` as an Effect, not a module-level constant.
 *
 * `Path.layer` builds a pure, synchronous service with no finalizer — nothing
 * to leak, nothing that benefits from a fresh instance per call. Resolving it
 * with Effect.runSync at import time was still an import-time side effect;
 * callers yield this instead (same shape as process-plugin/paths.ts and
 * configPath / pluginStoreDir).
 */
import { Effect } from "effect";
import * as Path from "effect/Path";

export const nodePath: Effect.Effect<Path.Path> = Path.Path.pipe(Effect.provide(Path.layer));
