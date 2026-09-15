/**
 * Builtin ex command table and resolution — owned by the vim engine so core
 * history mode and the editor plugin share one table without the Editor service.
 */
import type { EditorState } from "./schema.ts";

export type CommandNargs = "0" | "1" | "*";

/** Neovim-style `-complete=` — only `file` is wired today (arg Tab past the head). */
export type CommandComplete = "file";

export interface CommandRunArgs {
  readonly bang: boolean;
  readonly arg: string;
  readonly state: EditorState;
}

/** A registered ex command — builtins have no `run`; user commands must. */
export interface RegisteredCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly forceable: boolean;
  readonly nargs: CommandNargs;
  readonly complete?: CommandComplete;
  readonly run?: (args: CommandRunArgs) => void;
  readonly builtin?: "edit" | "write" | "quit" | "wq" | "x";
}

/** Builtin ex commands — same set the reducer historically hard-coded. */
export const BUILTIN_COMMANDS: readonly RegisteredCommand[] = [
  { name: "edit", aliases: ["e"], forceable: false, nargs: "1", complete: "file", builtin: "edit" },
  { name: "write", aliases: ["w"], forceable: false, nargs: "0", builtin: "write" },
  { name: "quit", aliases: ["q"], forceable: true, nargs: "0", builtin: "quit" },
  { name: "wq", aliases: [], forceable: false, nargs: "0", builtin: "wq" },
  { name: "x", aliases: [], forceable: false, nargs: "0", builtin: "x" },
  // Ex-depth (handled by tryExCommand before resolve — listed for Tab completion).
  { name: "set", aliases: ["se"], forceable: false, nargs: "*" },
  { name: "nohlsearch", aliases: ["noh", "nohl"], forceable: false, nargs: "0" },
  { name: "substitute", aliases: ["s"], forceable: false, nargs: "*" },
  { name: "delete", aliases: ["d"], forceable: false, nargs: "0" },
  { name: "move", aliases: ["m"], forceable: false, nargs: "1" },
  { name: "copy", aliases: ["t", "co"], forceable: false, nargs: "1" },
  { name: "put", aliases: ["pu"], forceable: false, nargs: "*" },
  { name: "read", aliases: ["r"], forceable: false, nargs: "1", complete: "file" },
];

/**
 * Resolve a command head against a table: exact name/alias first, then
 * unambiguous prefix of canonical names (aliases never prefix-match).
 */
export const resolveCommand = (
  head: string,
  commands: readonly RegisteredCommand[],
):
  | { readonly found: RegisteredCommand }
  | { readonly ambiguous: readonly RegisteredCommand[] }
  | null => {
  for (const command of commands) {
    if (command.name === head || command.aliases.includes(head)) return { found: command };
  }
  const matches = commands.filter((command) => command.name.startsWith(head));
  if (matches.length === 0) return null;
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { found: only };
  return { ambiguous: matches };
};
