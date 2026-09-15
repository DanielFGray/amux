// @effect-diagnostics-next-line nodeBuiltinImport:off -- resolve() is pure path math for the CLI cwd, not I/O.
import { resolve } from "node:path";
import { Effect, Schema as S } from "effect";
import {
  DaemonCommandsTag,
  PluginReducerError,
  creationResultSchema,
  defineDaemonCommand,
  definePaneType,
  definePlugin,
  registerDaemonCommand,
  type PluginDefinition,
} from "@danielfgray/amux";
import { EditorOpenArgs } from "./command-args.ts";

/** Descriptor for panes of type `amux.editor`. */
export const EditorDescriptorSchema = S.Struct({
  file: S.optionalKey(S.String),
});

const editorPane = definePaneType("amux.editor", EditorDescriptorSchema);

const editorOpen = defineDaemonCommand({
  tag: "editor.open",
  fields: EditorOpenArgs,
  meta: { desc: "open an editor pane", group: "editor", target: "workspace", exposure: "human" },
  resources: (args) => (args.file !== undefined ? [args.file] : []),
  result: creationResultSchema("pane.open-plugin"),
  paneTypes: [editorPane],
  reduce: ({ command, context, reads, build }) =>
    Effect.gen(function* () {
      // From inside a pane (CLI / shell with AMUX_PANE_ID, or the focused leaf
      // from the client): replace that leaf and keep the displaced PTY alive.
      // Remote call without a caller: split. `split: true` always splits.
      const raw = command.file?.trim() ?? "";
      const descriptor: typeof EditorDescriptorSchema.Type =
        raw.length === 0 ? {} : { file: raw.startsWith("/") ? raw : resolve(context.cwd, raw) };
      const target = reads.activeWindow;
      if (target === null) {
        return yield* new PluginReducerError({
          message: "plugin.place requires a target pane or window",
        });
      }
      if (command.split !== true && context.pane !== undefined) {
        const pane = context.pane;
        return build.answer([
          yield* editorPane.place({ mode: "replace", descriptor }),
          yield* build.result({ pane }),
        ]);
      }
      const pane = build.nextPaneId(target.space);
      return build.answer([
        yield* editorPane.place({ mode: "split", pane, descriptor }),
        yield* build.result({ pane }),
      ]);
    }),
});

export const editorDaemonCommands = [editorOpen] as const;

export const editorDaemonPlugin: PluginDefinition = definePlugin({
  id: "amux.editor.daemon",
  inject: [DaemonCommandsTag],
  effect: () =>
    Effect.gen(function* () {
      for (const registration of editorDaemonCommands) yield* registerDaemonCommand(registration);
    }),
});

export default editorDaemonPlugin;
