import { Effect } from "effect";
import {
  DaemonCommandsTag,
  definePlugin,
  registerDaemonCommand,
  type DaemonCommandRegistration,
  type PluginDefinition,
} from "@danielfgray/amux";

const editorOpen = {
  tag: "editor.open",
  fields: {},
  meta: { desc: "open an editor pane", group: "editor", target: "workspace", exposure: "human" },
  reduce: (draft) => {
    const pane = draft.placePluginPane("amux.editor", {});
    if (pane !== null) draft.setResult({ pane });
  },
} satisfies DaemonCommandRegistration;

export const editorDaemonCommands: readonly DaemonCommandRegistration[] = [editorOpen];

export const editorDaemonPlugin: PluginDefinition = definePlugin({
  id: "amux.editor.daemon",
  inject: [DaemonCommandsTag],
  effect: () =>
    Effect.gen(function* () {
      for (const registration of editorDaemonCommands)
        yield* registerDaemonCommand(registration);
    }),
});

export default editorDaemonPlugin;
