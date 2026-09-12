import { Effect } from "effect";
import { BunServices } from "@effect/platform-bun";
import { definePlugin } from "../plugin/types.ts";
import {
  BindingsTag,
  CommandsTag,
  ContextsTag,
  SlotsTag,
  type SlotsRegisterValue,
} from "../plugin/services.ts";
import { CONTEXT_PRIORITY, type ContextSpec } from "../key-context.ts";
import { OverlayTag } from "../plugin/overlay.ts";
import { CommandsChromeTag } from "../plugin/chrome.ts";
import { command, CurrentInvocation } from "../commands.ts";
import { loadProcessPluginBindingSpecs } from "../process-plugin/index.ts";
import { paletteOverlayKeys } from "./commands/keys.ts";
import { errorOverlayKeys, inspectOverlayKeys, promptOverlayKeys } from "./commands/overlay-keys.ts";
import { errorPanel, hintsPanel, inspectPanel, palettePanel, promptPanel } from "./commands/panel.tsx";

/**
 * Command palette, prompt, which-key, and error snack. File-backed for
 * `plugin.reload amux.commands`. Core keybindings are supplied by the host via
 * CommandsChrome and registered here so one plugin owns the chrome surface.
 * Linked process-plugin actions/panes are registered unbound so they appear in
 * the palette and can take keybinds; reload this plugin after `process-plugin link`.
 */
export default definePlugin({
  id: "amux.commands",
  inject: [SlotsTag, BindingsTag, CommandsTag, ContextsTag, OverlayTag, CommandsChromeTag],
  effect: () =>
    Effect.gen(function* () {
      const slots = yield* SlotsTag;
      const bindings = yield* BindingsTag;
      const commands = yield* CommandsTag;
      const contexts = yield* ContextsTag;
      const overlay = yield* OverlayTag;
      const chrome = yield* CommandsChromeTag;

      const panels: readonly SlotsRegisterValue[] = [
        { slot: "overlay", occupant: palettePanel(chrome, overlay), priority: 10 },
        { slot: "overlay", occupant: promptPanel(chrome), priority: 40 },
        {
          slot: "float",
          occupant: {
            ...hintsPanel(chrome),
            visible: () =>
              chrome.hintsVisible() && chrome.hints().length > 0 && slots.topOverlay() === null,
          },
        },
        { slot: "float", occupant: errorPanel(chrome), priority: 55 },
        { slot: "float", occupant: inspectPanel(chrome), priority: 56 },
      ];
      const specs: readonly ContextSpec[] = [
        {
          id: "amux.palette",
          active: () => overlay.is("palette"),
          priority: CONTEXT_PRIORITY.OVERLAY + 10,
          rebindable: false,
          handle: (event) => paletteOverlayKeys(chrome, overlay, event),
        },
        {
          id: "amux.prompt",
          active: () => chrome.prompt() !== null,
          priority: CONTEXT_PRIORITY.OVERLAY + 40,
          rebindable: false,
          handle: (event) => promptOverlayKeys(chrome, event),
        },
        {
          id: "amux.error",
          active: () => chrome.commandError() !== null,
          priority: CONTEXT_PRIORITY.OVERLAY + 55,
          rebindable: false,
          // Escape dismisses; other keys must reach the focused pane (ctrl+c/d).
          blocksPane: false,
          handle: (event) => errorOverlayKeys(chrome, event),
        },
        {
          id: "amux.inspect",
          active: () => chrome.inspectLines() !== null,
          priority: CONTEXT_PRIORITY.OVERLAY + 56,
          rebindable: false,
          blocksPane: false,
          handle: (event) => inspectOverlayKeys(chrome, event),
        },
      ];

      const processBindings = yield* loadProcessPluginBindingSpecs({
        runAction: (plugin, action) =>
          Effect.gen(function* () {
            const inv = yield* CurrentInvocation;
            yield* commands.run(
              command("process-plugin.action.invoke", { plugin, action }),
              inv,
            );
          }),
        runPane: (plugin, entrypoint) =>
          Effect.gen(function* () {
            const inv = yield* CurrentInvocation;
            yield* commands.run(
              command("process-plugin.pane.open", { plugin, entrypoint }),
              inv,
            );
          }),
      }).pipe(Effect.provide(BunServices.layer));

      yield* Effect.forEach(panels, (entry) => slots.register(entry));
      yield* Effect.forEach(chrome.coreBindings(), (binding) => bindings.register(binding));
      yield* Effect.forEach(processBindings, (binding) => bindings.register(binding));
      yield* Effect.forEach(specs, (context) => contexts.register(context));
    }),
});
