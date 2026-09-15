/**
 * TypeScript surface for the editor — the analogue of Neovim's `vim.*` API,
 * named `editor` so callers write `editor.command.add` / `editor.keymap.set`.
 *
 * Amux plugins package and inject this service (`inject: [Editor]`); they do
 * not get a second plugin host. The registries here are sync so `./embed` can
 * reuse the same tables without the Effect activation graph.
 *
 * Builtin ex commands live in `@danielfgray/amux-vim`; user commands register a
 * `run` and surface as `{ _tag: "invoke" }` requests the pane fulfils.
 */
import { Context } from "effect";
import {
  BUILTIN_COMMANDS,
  type CommandComplete,
  type CommandNargs,
  type CommandRunArgs,
  type EditorMode,
  type RegisteredCommand,
} from "@danielfgray/amux-vim";

export interface AddCommandSpec {
  readonly aliases?: readonly string[];
  readonly forceable?: boolean;
  readonly nargs?: CommandNargs;
  readonly complete?: CommandComplete;
  readonly run: (args: CommandRunArgs) => void;
}

export type KeymapMode = EditorMode;

export interface EditorService {
  readonly command: {
    readonly add: (name: string, spec: AddCommandSpec) => () => void;
    readonly list: () => readonly RegisteredCommand[];
    /** Run a user command by name; no-op when missing or builtin. */
    readonly invoke: (name: string, args: CommandRunArgs) => void;
  };
  readonly keymap: {
    readonly set: (
      mode: KeymapMode | readonly KeymapMode[],
      lhs: string,
      rhs: string,
    ) => () => void;
    readonly lookup: (mode: KeymapMode, lhs: string) => string | undefined;
  };
}

/** Inject as `Editor`; bind the service as `editor`. */
export class Editor extends Context.Service<Editor, EditorService>()("amux.editor/Editor") {}

export function createEditor(
  builtins: readonly RegisteredCommand[] = BUILTIN_COMMANDS,
): EditorService {
  const user = new Map<string, RegisteredCommand>();
  const maps = new Map<string, string>();

  const commands = (): readonly RegisteredCommand[] => {
    const overridden = new Set(user.keys());
    return [...builtins.filter((command) => !overridden.has(command.name)), ...user.values()];
  };

  const command = {
    add(name: string, spec: AddCommandSpec): () => void {
      if (name.length === 0) throw new Error("command name must be non-empty");
      if (user.has(name)) throw new Error(`command '${name}' is already registered`);
      const entry: RegisteredCommand =
        spec.complete !== undefined
          ? {
              name,
              aliases: spec.aliases ?? [],
              forceable: spec.forceable ?? false,
              nargs: spec.nargs ?? "0",
              complete: spec.complete,
              run: spec.run,
            }
          : {
              name,
              aliases: spec.aliases ?? [],
              forceable: spec.forceable ?? false,
              nargs: spec.nargs ?? "0",
              run: spec.run,
            };
      user.set(name, entry);
      return () => {
        if (user.get(name) === entry) user.delete(name);
      };
    },
    list: commands,
    invoke(name: string, args: CommandRunArgs): void {
      const entry = commands().find((command) => command.name === name);
      entry?.run?.(args);
    },
  };

  const mapKey = (mode: KeymapMode, lhs: string) => `${mode}\0${lhs}`;

  const keymap = {
    set(mode: KeymapMode | readonly KeymapMode[], lhs: string, rhs: string): () => void {
      const modes = typeof mode === "string" ? [mode] : mode;
      if (lhs.length === 0) throw new Error("keymap lhs must be non-empty");
      const keys = modes.map((m) => mapKey(m, lhs));
      for (const key of keys) maps.set(key, rhs);
      return () => {
        for (const key of keys) {
          if (maps.get(key) === rhs) maps.delete(key);
        }
      };
    },
    lookup(mode: KeymapMode, lhs: string): string | undefined {
      return maps.get(mapKey(mode, lhs));
    },
  };

  return { command, keymap };
}
