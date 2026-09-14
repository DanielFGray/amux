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
import type { DirEntry } from "../command-completion.ts";
import { EditorIo, type EditorIoService } from "../io.ts";

export interface TestEditorIoState {
  readonly files: Map<string, string[]>;
  readonly failReads: ReadonlySet<string>;
  readonly spaceDir: string;
  /** Explicit directories so empty dirs still appear in `:e` completion. */
  readonly directories?: ReadonlySet<string>;
  /** Optional canned `:r!` outputs keyed by exact cmd string. */
  readonly shell?: Readonly<
    Record<
      string,
      { readonly lines: readonly string[]; readonly exitCode?: number; readonly stderr?: string }
    >
  >;
  /**
   * Optional gate before a successful read returns. Used to prove mount-time
   * loads serialize with the key queue (ts-d3ce27): hold the gate, type keys,
   * then release — edits must apply after the load, not be wiped by it.
   */
  readonly beforeRead?: () => Effect.Effect<void>;
}

const resolvePath = (spaceDir: string, p: string): string =>
  p === "" || p === "." ? spaceDir : p.startsWith("/") ? p : `${spaceDir}/${p}`;

/** Derive directory entries from seeded file keys (+ optional empty dirs). */
const entriesUnder = (state: TestEditorIoState, dir: string): readonly DirEntry[] => {
  const resolved = resolvePath(state.spaceDir, dir);
  const prefix = resolved.endsWith("/") ? resolved : `${resolved}/`;
  const names = new Map<string, DirEntry["kind"]>();
  for (const key of state.files.keys()) {
    const absolute = key.startsWith("/") ? key : resolvePath(state.spaceDir, key);
    if (!absolute.startsWith(prefix)) continue;
    const rest = absolute.slice(prefix.length);
    if (rest.length === 0) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) names.set(rest, "file");
    else names.set(rest.slice(0, slash), "directory");
  }
  for (const directory of state.directories ?? []) {
    const absolute = directory.startsWith("/") ? directory : resolvePath(state.spaceDir, directory);
    if (!absolute.startsWith(prefix)) continue;
    const rest = absolute.slice(prefix.length);
    if (rest.length === 0) continue;
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (name.length > 0) names.set(name, "directory");
  }
  return [...names.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, kind]) => ({ name, kind }));
};

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
    const succeed = Effect.succeed({ file: resolved, lines: [...lines] });
    return state.beforeRead === undefined
      ? succeed
      : state.beforeRead().pipe(Effect.andThen(succeed));
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
  resolve: (spaceDir, p) => Effect.sync(() => resolvePath(spaceDir, p)),
  listEntries: (dir, _spaceDir) => Effect.sync(() => entriesUnder(state, dir === "" ? "." : dir)),
  shell: (cmd, _spaceDir) => {
    const canned = state.shell?.[cmd];
    if (canned !== undefined) {
      return Effect.succeed({
        lines: [...canned.lines],
        exitCode: canned.exitCode ?? 0,
        stderr: canned.stderr ?? "",
      });
    }
    // Default: echo the cmd so unit tests can assert without seeding.
    return Effect.succeed({ lines: [cmd], exitCode: 0, stderr: "" });
  },
});

export const TestEditorIo = (initial: TestEditorIoState): Layer.Layer<EditorIo> =>
  Layer.succeed(EditorIo, makeTestEditorIo(initial));

/** Re-exported for tests that want a `Context.Tag` lookup, not the `Layer`. */
export { EditorIo } from "../io.ts";
