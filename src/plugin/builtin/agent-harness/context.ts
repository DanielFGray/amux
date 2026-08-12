import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/** Build the immutable system context for a newly created provider conversation. */
export async function initialContext(options: {
  readonly workspace: string;
  readonly now?: Date;
  readonly platform?: string;
  readonly configDirectory?: string;
}): Promise<string> {
  const workspace = resolve(options.workspace);
  const instructions = await instructionFiles({
    workspace,
    configDirectory: options.configDirectory,
  });
  const facts = [
    "You are a coding agent running inside amux.",
    `Workspace: ${workspace}`,
    `Platform: ${options.platform ?? process.platform}`,
    `Date: ${(options.now ?? new Date()).toISOString().slice(0, 10)}`,
  ];
  return [...facts, ...instructions].join("\n\n");
}

/**
 * Global instructions apply first. Ancestor instructions then apply from the
 * workspace root toward the active directory, so closer files can refine them.
 */
export async function instructionFiles(options: {
  readonly workspace: string;
  readonly configDirectory?: string;
}): Promise<readonly string[]> {
  const workspace = resolve(options.workspace);
  const global = options.configDirectory ?? configDirectory();
  const paths = [
    ...INSTRUCTION_FILES.map((name) => join(global, name)),
    ...ancestorDirectories(workspace).flatMap((directory) =>
      INSTRUCTION_FILES.map((name) => join(directory, name)),
    ),
  ];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const path of paths) {
    const absolute = resolve(path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const content = await readFile(absolute, "utf8").catch(() => undefined);
    if (content?.trim()) values.push(`Instructions from: ${absolute}\n${content.trimEnd()}`);
  }
  return values;
}

function configDirectory(): string {
  const root = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config");
  return join(root, "amux");
}

function ancestorDirectories(workspace: string): readonly string[] {
  const paths: string[] = [];
  let current = resolve(workspace);
  while (true) {
    paths.unshift(current);
    const parent = dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}
