import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Config, DateTime, Effect, Option } from "effect";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = path.resolve(options.workspace);
  const global = options.configDirectory ?? (yield* configDirectory);
  const paths = [
    ...INSTRUCTION_FILES.map((name) => path.join(global, name)),
    ...(yield* ancestorDirectories(workspace)).flatMap((directory) =>
      INSTRUCTION_FILES.map((name) => path.join(directory, name)),
    ),
  ];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const file of paths) {
    const absolute = path.resolve(file);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const content = yield* fs
      .readFileString(absolute)
      .pipe(Effect.catchTag("PlatformError", () => Effect.void));
    if (content?.trim()) values.push(`Instructions from: ${absolute}\n${content.trimEnd()}`);
  }
  return values;
});

const configDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const xdg = yield* Config.option(Config.string("XDG_CONFIG_HOME"));
  const home = yield* Config.string("HOME").pipe(Effect.orElseSucceed(() => "."));
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
