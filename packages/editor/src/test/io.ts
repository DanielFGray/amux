/**
 * In-memory `EditorIo` for the plugin test harness.
 *
 * Reads come from a `Map<path, lines>` seeded at activation; writes replace
 * the entry and the test can read them back. A `failReads` set lets a test
 * reproduce the "missing file" path without touching the real filesystem.
 *
 * The harness uses the *resolved* (absolute) path as the key — the same
 * path the production `EditorIo` would have built via `Path.resolve`. A
 * basename fallback lets a test seed fixtures by the short name when the
 * resolved path isn't convenient to compute.
 */
import { Effect, Layer } from "effect";
import { systemError } from "effect/PlatformError";
import { EditorIo, type EditorIoService } from "../io.ts";

export interface TestEditorIoState {
  readonly files: Map<string, string[]>;
  readonly failReads: ReadonlySet<string>;
  readonly spaceDir: string;
}

export const makeTestEditorIo = (state: TestEditorIoState): EditorIoService => ({
  read: (file, spaceDir) => {
    // Mirror `Path.resolve`: an absolute `file` wins; relative paths
    // root at `spaceDir`. The test seeds files by basename (or full
    // path); we try every key form to find the entry.
    const resolved = file.startsWith("/") ? file : `${spaceDir}/${file}`;
    const basename = file.startsWith("/") ? file.slice(spaceDir.length + 1) : file;
    if (state.failReads.has(file) || state.failReads.has(resolved)) {
      return Effect.fail(
        systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: resolved,
        }),
      );
    }
    const lines = state.files.get(file) ?? state.files.get(resolved) ?? state.files.get(basename);
    if (lines === undefined) {
      return Effect.fail(
        systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: resolved,
        }),
      );
    }
    return Effect.succeed({ file: resolved, lines: [...lines] });
  },
  write: (file, lines, spaceDir) => {
    const resolved = file.startsWith("/") ? file : `${spaceDir}/${file}`;
    const basename = file.startsWith("/") ? file.slice(spaceDir.length + 1) : file;
    return Effect.sync(() => {
      state.files.set(file, [...lines]);
      state.files.set(resolved, [...lines]);
      state.files.set(basename, [...lines]);
    });
  },
  resolve: (spaceDir, p) => Effect.sync(() => (p.startsWith("/") ? p : `${spaceDir}/${p}`)),
});

export const TestEditorIo = (initial: TestEditorIoState): Layer.Layer<EditorIo> =>
  Layer.succeed(EditorIo, makeTestEditorIo(initial));

/** Re-exported for tests that want a `Context.Tag` lookup, not the `Layer`. */
export { EditorIo } from "../io.ts";
