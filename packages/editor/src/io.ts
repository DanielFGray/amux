/**
 * The editor's filesystem surface, declared as an `Effect` `Service`.
 *
 * The plugin builds the live implementation at activation
 * (`plugin.tsx`'s `buildEditorIo`), publishes it for future consumers,
 * and hands the same instance to the pane view through its props — so
 * the pane and any future consumer read through one instance.
 * A test swaps in an in-memory version (`./test/io.ts`) by mounting
 * the view directly, the way the bench already does.
 *
 * `PlatformError` flows through the typed error channel rather than
 * surfacing as a stringified `Error`, which was the original
 * `Effect.runPromise` smell.
 */
import { Context, Effect, FileSystem, Path, Schema as S } from "effect";
import { PlatformError } from "effect/PlatformError";
import type { DirEntry } from "./command-completion.ts";

export type { DirEntry } from "./command-completion.ts";

/**
 * The remount contract of an `amux.editor` pane, shared by the daemon command
 * that places the pane and the pane view that reads it back. `file` is absent
 * for an editor opened with no file, so an empty descriptor is a value the view
 * understands rather than a decode failure.
 */
export const EditorDescriptor = S.Struct({ file: S.optionalKey(S.String) });
export type EditorDescriptor = S.Schema.Type<typeof EditorDescriptor>;

export const EditorReadResult = S.Struct({
  file: S.String,
  lines: S.Array(S.String),
  /** Present when the read also opened the daemon document store. */
  generation: S.optional(S.Int),
});
export type EditorReadResult = S.Schema.Type<typeof EditorReadResult>;

/** Result of `:r!{cmd}` — stdout lines plus exit metadata for the status line. */
export type EditorShellResult = {
  readonly lines: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
};

export class EditorShellError extends S.TaggedError<EditorShellError>()("EditorShellError", {
  message: S.String,
}) {}

/**
 * Run `cmd` via `shellBin -c` (vim 'shell' / `$SHELL`). Shared by the live
 * plugin Io and the bench Io so neither hard-codes `sh`.
 */
export const runShellCommand = Effect.fnUntraced(function* (
  shellBin: string,
  cmd: string,
  cwd: string,
) {
  const trimmed = shellBin.trim();
  const bin = trimmed.length === 0 ? "sh" : trimmed;
  const proc = Bun.spawn([bin, "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = yield* Effect.tryPromise({
    try: () => new Response(proc.stdout).text(),
    catch: () => new EditorShellError({ message: "shell stdout failed" }),
  });
  const stderr = yield* Effect.tryPromise({
    try: () => new Response(proc.stderr).text(),
    catch: () => new EditorShellError({ message: "shell stderr failed" }),
  });
  const exitCode = yield* Effect.tryPromise({
    try: () => proc.exited,
    catch: () => new EditorShellError({ message: "shell wait failed" }),
  });
  const raw = stdout.split("\n");
  const lines = raw.at(-1) === "" ? raw.slice(0, -1) : raw;
  return { lines, exitCode, stderr: stderr.trimEnd() } satisfies EditorShellResult;
});

export interface EditorIoService {
  readonly read: (file: string, spaceDir: string) => Effect.Effect<EditorReadResult, PlatformError>;
  readonly write: (
    file: string,
    lines: readonly string[],
    spaceDir: string,
  ) => Effect.Effect<void, PlatformError>;
  readonly resolve: (spaceDir: string, path: string) => Effect.Effect<string, never>;
  /** Entries in `dir` (relative to `spaceDir`, or absolute). Used by `:e` Tab. */
  readonly listEntries: (
    dir: string,
    spaceDir: string,
  ) => Effect.Effect<readonly DirEntry[], PlatformError>;
  /**
   * Run `cmd` via `$SHELL -c` (fallback `sh`) with cwd `spaceDir`. Used by `:r!`.
   * Always returns stdout lines; non-zero exit is carried in the result
   * (vim still inserts output). Cite: vim 'shell' option.
   */
  readonly shell: (
    cmd: string,
    spaceDir: string,
  ) => Effect.Effect<EditorShellResult, EditorShellError>;
}

/** Filesystem-backed `listEntries` for the live and bench `EditorIo`s. */
export const listEntriesWith =
  (fs: FileSystem.FileSystem, path: Path.Path): EditorIoService["listEntries"] =>
  (dir, spaceDir) =>
    Effect.gen(function* () {
      const resolved =
        dir === "" || dir === "."
          ? spaceDir
          : dir.startsWith("/")
            ? dir
            : path.resolve(spaceDir, dir);
      const names = yield* fs.readDirectory(resolved);
      return yield* Effect.forEach(
        names,
        (name) =>
          fs.stat(path.join(resolved, name)).pipe(
            Effect.map((stat): DirEntry => ({
              name,
              kind: stat.type === "Directory" ? "directory" : "file",
            })),
            Effect.orElseSucceed((): DirEntry => ({ name, kind: "file" })),
          ),
        { concurrency: "unbounded" },
      );
    });

export class EditorIo extends Context.Service<EditorIo, EditorIoService>()("amux.editor/Io") {}
