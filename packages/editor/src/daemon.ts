// @effect-diagnostics-next-line nodeBuiltinImport:off -- resolve() is pure path math for the CLI cwd, not I/O.
import { resolve } from "node:path";
import { Effect, Schema as S } from "effect";
import {
  DaemonCommandsTag,
  commandResultCodec,
  creationResultSchema,
  definePlugin,
  paneDescriptorCodec,
  registerDaemonCommand,
  type DaemonCommandRegistration,
  type JsonValue,
  type PluginDefinition,
} from "@danielfgray/amux";

/** Descriptor for panes of type `amux.editor`. */
export const EditorDescriptorSchema = S.Struct({
  file: S.optionalKey(S.String),
});

const editorOpen = {
  tag: "editor.open",
  fields: {
    // Optional path: `amux editor.open src/foo.ts` opens that file. Relative
    // paths resolve against the calling cwd (CLI / pane), matching :e.
    file: S.optionalKey(S.String),
    // Force a sibling split even when invoked from a pane (AMUX_PANE_ID).
    split: S.optionalKey(S.Boolean),
  },
  meta: { desc: "open an editor pane", group: "editor", target: "workspace", exposure: "human" },
  resources: (args) => (typeof args.file === "string" ? [args.file] : []),
  result: commandResultCodec(creationResultSchema("pane.open-plugin")),
  paneDescriptors: [paneDescriptorCodec("amux.editor", EditorDescriptorSchema)],
  reduce: ({ command, context }) =>
    Effect.sync(() => {
      // From inside a pane (CLI / shell with AMUX_PANE_ID, or the focused leaf
      // from the client): replace that leaf and keep the displaced PTY alive.
      // Remote call without a caller: split. `split: true` always splits.
      const mode =
        command.split === true ? "split" : context.pane !== undefined ? "replace" : "split";
      const raw = typeof command.file === "string" ? command.file.trim() : "";
      const descriptor: JsonValue =
        raw.length === 0
          ? {}
          : { file: raw.startsWith("/") ? raw : resolve(context.cwd, raw) };
      return {
        changes: [
          {
            _tag: "plugin.place" as const,
            ref: "pane",
            type: "amux.editor",
            descriptor,
            mode,
          },
          {
            _tag: "result.set" as const,
            result: { pane: { _tag: "WorkspaceRef", ref: "pane" } },
          },
        ],
      };
    }),
} satisfies DaemonCommandRegistration;

export const editorDaemonCommands: readonly DaemonCommandRegistration[] = [editorOpen];

export const editorDaemonPlugin: PluginDefinition = definePlugin({
  id: "amux.editor.daemon",
  inject: [DaemonCommandsTag],
  effect: () =>
    Effect.gen(function* () {
      for (const registration of editorDaemonCommands) yield* registerDaemonCommand(registration);
    }),
});

export default editorDaemonPlugin;
