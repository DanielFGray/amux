/**
 * `Path.Path`, resolved once at module load rather than by each caller.
 *
 * `Path.layer` builds a pure, synchronous service with no finalizer — nothing
 * to leak, nothing that benefits from a fresh instance per call. git.ts,
 * workspace.ts and project-store.ts each used to run this exact
 * `Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)))` themselves;
 * sharing the one resolution here is what actually removes the duplication,
 * not routing it through a runtime that does not yet exist at their module
 * load time either.
 */
import { Effect } from "effect";
import * as Path from "effect/Path";

export const nodePath: Path.Path = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
