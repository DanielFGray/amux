/**
 * Unlink a leftover Unix socket file so a later listen is not stuck on
 * EADDRINUSE after a crash. Missing is fine; any other PlatformError is a defect.
 */
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";

export const removeStaleSocket = (
  path: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .remove(path)
      .pipe(
        Effect.catchTag("PlatformError", (e) =>
          e.reason._tag === "NotFound" ? Effect.void : Effect.die(e),
        ),
      );
  });
