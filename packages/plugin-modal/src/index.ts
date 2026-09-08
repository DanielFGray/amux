import { createSignal } from "solid-js";
import { Effect } from "effect";
import {
  BindingsTag,
  command,
  CONTEXT_PRIORITY,
  ContextsTag,
  contextCommand,
  definePlugin,
  OptionsTag,
  PanelTag,
  type ContextSpec,
  type PluginDefinition,
} from "@danielfgray/amux";

export const MODAL_PLUGIN_ID = "amux.modal";

export const modalPlugin: PluginDefinition = definePlugin({
  id: MODAL_PLUGIN_ID,
  inject: [BindingsTag, ContextsTag, OptionsTag, PanelTag],
  effect: () =>
    Effect.gen(function* () {
      const bindings = yield* BindingsTag;
      const contexts = yield* ContextsTag;
      const options = yield* OptionsTag;
      const panel = yield* PanelTag;
      const [active, setActive] = createSignal(false);
      const leaveAfterAction = Effect.sync(() => {
        if (panel.options()["modal.vimMode"] !== true) setActive(false);
      });
      const amux: ContextSpec = {
        id: "modal.amux",
        active,
        priority: CONTEXT_PRIORITY.APP_MODE + 2,
        rebindable: false,
        showOnEntry: true,
        handle: () => {
          setActive(false);
          return true;
        },
      };
      const action = (key: string, desc: string, direction: "left" | "right" | "up" | "down") =>
        contextCommand(amux, {
          name: `resize-${direction}`,
          key,
          desc,
          group: "amux",
          run: panel.run(command("pane.resize", { direction })).pipe(Effect.ensuring(leaveAfterAction)),
        });
      yield* options.register([
        "modal.vimMode",
        { kind: "boolean", default: false, desc: "keep amux mode active after a command" },
      ]);
      yield* contexts.register(amux);
      yield* bindings.register({
        name: "modal.enter",
        key: "<leader>",
        desc: "enter amux mode",
        group: "amux",
        run: Effect.sync(() => setActive(true)),
      });
      yield* Effect.forEach(["escape", "i"], (key) =>
        bindings.register(
          contextCommand(amux, {
            name: key === "escape" ? "exit" : "insert",
            key,
            desc: "leave amux mode",
            group: "amux",
            run: Effect.sync(() => setActive(false)),
          }),
        ),
      );
      yield* Effect.forEach([
        action("h", "resize left", "left"), action("j", "resize down", "down"),
        action("k", "resize up", "up"), action("l", "resize right", "right"),
      ], (binding) => bindings.register(binding));
    }),
});

export default modalPlugin;
