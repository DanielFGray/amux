// @effect-diagnostics-next-line nodeBuiltinImport:off -- resolve() is pure path math for the CLI cwd, not I/O.
import { resolve } from "node:path";
import { Effect, Schema as S } from "effect";
import {
  DaemonCommandsTag,
  definePlugin,
  registerDaemonCommand,
  type DaemonCommandRegistration,
  type JsonValue,
  type PluginDefinition,
} from "@danielfgray/amux";

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
  reduce: (draft, command, context) => {
    // From inside a pane (CLI / shell with AMUX_PANE_ID, or the focused leaf
    // from the client): replace that leaf and keep the displaced PTY alive.
    // Remote call without a caller: split. `split: true` always splits.
    const mode =
      command.split === true ? "split" : context.pane !== undefined ? "replace" : "split";
    const raw = typeof command.file === "string" ? command.file.trim() : "";
    const descriptor: JsonValue =
      raw.length === 0 ? {} : { file: raw.startsWith("/") ? raw : resolve(context.cwd, raw) };
    const pane = draft.placePluginPane("amux.editor", descriptor, { mode });
    if (pane !== null) draft.setResult({ pane });
  },
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
