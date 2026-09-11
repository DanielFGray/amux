import { Effect } from "effect";
import { definePlugin } from "../plugin/types.ts";
import { ContextsTag, SlotsTag, type SlotsRegisterValue } from "../plugin/services.ts";
import { CONTEXT_PRIORITY, type ContextSpec } from "../key-context.ts";
import { OverlayTag } from "../plugin/overlay.ts";
import { SettingsChromeTag } from "../plugin/chrome.ts";
import { keybindPickerKey, settingsKey } from "./settings/keys.ts";
import { keybindPickerPanel, settingsPanel } from "./settings/panel.tsx";

/**
 * Settings overlay + keybind picker. File-backed so `plugin.reload amux.settings`
 * reimports this module (Cordis entry.url). State lives on Overlay + SettingsChrome.
 */
export default definePlugin({
  id: "amux.settings",
  inject: [SlotsTag, ContextsTag, OverlayTag, SettingsChromeTag],
  effect: () =>
    Effect.gen(function* () {
      const slots = yield* SlotsTag;
      const contexts = yield* ContextsTag;
      const overlay = yield* OverlayTag;
      const chrome = yield* SettingsChromeTag;

      const panels: readonly SlotsRegisterValue[] = [
        { slot: "overlay", occupant: settingsPanel(chrome, overlay), priority: 10 },
        { slot: "overlay", occupant: keybindPickerPanel(chrome), priority: 15 },
      ];
      const specs: readonly ContextSpec[] = [
        {
          id: "amux.settings",
          active: () => overlay.is("settings"),
          priority: CONTEXT_PRIORITY.OVERLAY + 10,
          rebindable: false,
          handle: (event) => settingsKey(chrome, overlay, event),
        },
        {
          id: "amux.keybind-picker",
          active: () => chrome.keybindPicker() !== null,
          priority: CONTEXT_PRIORITY.OVERLAY + 15,
          rebindable: false,
          handle: (event) => keybindPickerKey(chrome, event),
        },
      ];

      yield* Effect.forEach(panels, (entry) => slots.register(entry));
      yield* Effect.forEach(specs, (context) => contexts.register(context));
    }),
});
