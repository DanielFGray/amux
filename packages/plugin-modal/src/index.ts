import { createSignal } from "solid-js";
import { Effect, Scope } from "effect";
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
      const scope = yield* Scope.Scope;
      const [active, setActive] = createSignal(false);
      const enter = () => setActive(true);
      const leave = () => setActive(false);
      const afterAction = () => {
        if (!panel.options()["modal.vimMode"]) leave();
      };
      const entry: ContextSpec = {
        id: "modal.entry",
        active: () => !active(),
        priority: CONTEXT_PRIORITY.APP_MODE + 2,
        rebindable: false,
      };
      const amux: ContextSpec = {
        id: "modal.amux",
        active,
        priority: CONTEXT_PRIORITY.APP_MODE + 2,
        rebindable: false,
        globalLeaderAliases: { afterCommand: afterAction },
        showOnEntry: true,
        rearmHintsOnKey: true,
        handle: () => {
          leave();
          return true;
        },
      };
      const action = (key: string, desc: string, direction: "left" | "right" | "up" | "down") =>
        contextCommand(amux, {
          name: `resize-${direction}`,
          key,
          desc,
          group: "amux",
          run: panel
            .run(command("pane.resize", { direction }))
            .pipe(Effect.ensuring(leaveAfterAction)),
        });
      yield* options.register([
        "modal.vimMode",
        { kind: "boolean", default: false, desc: "keep amux mode active after a command" },
      ]);
      const leaveAfterAction = Effect.sync(afterAction);
      yield* Scope.addFinalizer(scope, Effect.sync(leave));
      yield* contexts.register(entry);
      yield* contexts.register(amux);
      yield* bindings.register(
        contextCommand(entry, {
          name: "enter",
          key: "<prefix>",
          desc: "enter amux mode",
          group: "amux",
          run: Effect.sync(enter),
        }),
      );
      yield* Effect.forEach(["escape", "i"], (key) =>
        bindings.register(
          contextCommand(amux, {
            name: key === "escape" ? "exit" : "insert",
            key,
            desc: "leave amux mode",
            group: "amux",
            run: Effect.sync(leave),
          }),
        ),
      );
      yield* Effect.forEach(
        [
          action("alt+h", "resize left", "left"),
          action("alt+j", "resize down", "down"),
          action("alt+k", "resize up", "up"),
          action("alt+l", "resize right", "right"),
        ],
        (binding) => bindings.register(binding),
      );
    }),
});

export default modalPlugin;
