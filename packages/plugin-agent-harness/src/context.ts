import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Config, DateTime, Effect, Option } from "effect";

/** Checked in order; the first present, non-empty file in a directory wins —
 *  an override always wins there over the plain files it lives alongside. */
const INSTRUCTION_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];

/** Build the immutable system context for a newly created provider conversation. */
export const initialContext = Effect.fnUntraced(function* (options: {
  readonly workspace: string;
  readonly now?: Date;
  readonly platform?: string;
  readonly configDirectory?: string;
}) {
  const path = yield* Path.Path;
  const workspace = path.resolve(options.workspace);
  const instructions = yield* instructionFiles({
    workspace,
    configDirectory: options.configDirectory,
  });
  const date = options.now
    ? DateTime.makeUnsafe(options.now)
    : yield* DateTime.now.pipe(Effect.map(DateTime.makeUnsafe));
  const facts = [
    "You are a coding agent running inside amux.",
    `Workspace: ${workspace}`,
    `Platform: ${options.platform ?? process.platform}`,
    `Date: ${DateTime.formatIsoDate(date)}`,
  ];
  return [...facts, ...instructions].join("\n\n");
});

/**
 * Global instructions apply first. Ancestor instructions then apply from the
 * workspace root toward the active directory, so closer files can refine them.
 */
export const instructionFiles = Effect.fnUntraced(function* (options: {
  readonly workspace: string;
  readonly configDirectory?: string;
}) {
  const path = yield* Path.Path;
  const workspace = path.resolve(options.workspace);
  const global = options.configDirectory ?? (yield* configDirectory);
  const directories = [global, ...(yield* ancestorDirectories(workspace))];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const directory of directories) {
    const found = yield* instructionFileForDirectory(directory);
    if (!found || seen.has(found.path)) continue;
    seen.add(found.path);
    values.push(`Instructions from: ${found.path}\n${found.content}`);
  }
  return values;
});

/** The one instruction file a directory contributes, per `INSTRUCTION_CANDIDATES`. */
const instructionFileForDirectory = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of INSTRUCTION_CANDIDATES) {
    const absolute = path.join(directory, name);
    const content = yield* fs
      .readFileString(absolute)
      .pipe(Effect.catchTag("PlatformError", () => Effect.void));
    if (content?.trim()) return { path: absolute, content: content.trimEnd() };
  }
  return undefined;
});

const configDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const xdg = yield* Config.option(Config.String("XDG_CONFIG_HOME"));
  const home = yield* Config.String("HOME").pipe(Effect.orElseSucceed(() => "."));
  return path.join(
    Option.getOrElse(xdg, () => path.join(home, ".config")),
    "amux",
  );
});

const ancestorDirectories = Effect.fnUntraced(function* (workspace: string) {
  const path = yield* Path.Path;
  const paths: string[] = [];
  let current = path.resolve(workspace);
  while (true) {
    paths.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
});

/**
 * Instructions for one subtree a tool call is about to enter, skipping files a
 * session has already been shown.
 *
 * The workspace's own instructions are `initialContext`'s job; this only
 * covers directories strictly below it, so a tool call that never leaves the
 * workspace root finds nothing left to attach.
 */
export const nestedInstructions = Effect.fnUntraced(function* (options: {
  readonly workspace: string;
  readonly directory: string;
  readonly attached: ReadonlySet<string>;
}) {
  const path = yield* Path.Path;
  const directories = yield* directoriesBetween(
    path.resolve(options.workspace),
    path.resolve(options.directory),
  );
  const paths: string[] = [];
  const values: string[] = [];
  for (const directory of directories) {
    const found = yield* instructionFileForDirectory(directory);
    if (!found || options.attached.has(found.path)) continue;
    paths.push(found.path);
    values.push(`Instructions from: ${found.path}\n${found.content}`);
  }
  return { paths, content: values.join("\n\n") };
});

/** Directories strictly below `workspace`, shallow to deep, ending at `leaf`. */
const directoriesBetween = Effect.fnUntraced(function* (workspace: string, leaf: string) {
  const path = yield* Path.Path;
  const chain: string[] = [];
  let current = leaf;
  while (current !== workspace) {
    chain.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
});
