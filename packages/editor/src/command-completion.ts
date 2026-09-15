/**
 * Ex-command argument completion — the half Tab past the first space owns.
 *
 * Name completion stays in `vim-core`'s sync reducer. File completion is
 * declarative on the command (`complete: "file"`, Neovim `-complete=file`)
 * and this module turns a directory listing into picker items the pane shows.
 */
import type { CompletionItem } from "@danielfgray/amux-plugin-completion";
import { resolveCommand, type RegisteredCommand } from "@danielfgray/amux-vim";

export interface DirEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
}

/** When the line is past the command name and that command asks for files. */
export interface FileArgCompletion {
  readonly kind: "file";
  /** Canonical head including bang when forced (`edit` / `edit!`). */
  readonly head: string;
  /** Everything after the first space — the path prefix under completion. */
  readonly prefix: string;
}

/**
 * Resolve whether the live command line should complete a file argument.
 * No space → name completion (caller's job). Unknown / ambiguous head → none.
 */
export const fileArgCompletion = (
  line: string,
  commands: readonly RegisteredCommand[],
): FileArgCompletion | null => {
  const space = line.indexOf(" ");
  if (space < 0) return null;
  const rawHead = line.slice(0, space);
  const prefix = line.slice(space + 1);
  const force = rawHead.endsWith("!") && rawHead.length > 1;
  const bare = force ? rawHead.slice(0, -1) : rawHead;
  const resolved = resolveCommand(bare, commands);
  if (resolved === null || "ambiguous" in resolved) return null;
  if (resolved.found.complete !== "file") return null;
  if (force && !resolved.found.forceable) return null;
  return {
    kind: "file",
    head: `${resolved.found.name}${force ? "!" : ""}`,
    prefix,
  };
};

/** Split a path prefix into the directory to list and the basename filter. */
export const splitPathPrefix = (prefix: string) => {
  const slash = prefix.lastIndexOf("/");
  if (slash < 0) return { dir: "", base: prefix } as const;
  return { dir: prefix.slice(0, slash), base: prefix.slice(slash + 1) } as const;
};

/**
 * Build picker rows from one directory listing. Directories keep a trailing
 * slash so the next Tab continues into them (vim path completion).
 */
export const fileCompletionItems = (
  head: string,
  prefix: string,
  entries: readonly DirEntry[],
): readonly CompletionItem[] => {
  const { dir, base } = splitPathPrefix(prefix);
  const showDot = base.startsWith(".");
  return entries
    .filter((entry) => {
      if (!showDot && entry.name.startsWith(".")) return false;
      return entry.name.startsWith(base);
    })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const joined = dir.length === 0 ? entry.name : `${dir}/${entry.name}`;
      const path = entry.kind === "directory" ? `${joined}/` : joined;
      return {
        id: path,
        label: path,
        detail: entry.kind === "directory" ? "directory" : "file",
        replacement: `${head} ${path}`,
      };
    });
};
