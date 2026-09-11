/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import type { OverlayOccupant } from "../../ui/slots.ts";
import { Settings } from "../../ui/Settings.tsx";
import { KeybindPicker } from "../../ui/KeybindPicker.tsx";
import type { OverlayService } from "../../plugin/overlay.ts";
import type { SettingsChrome } from "../../plugin/chrome.ts";

export const settingsPanel = (
  chrome: SettingsChrome,
  overlay: OverlayService,
): OverlayOccupant => ({
  id: "amux.settings",
  title: "settings",
  visible: () => overlay.is("settings"),
  component: (props) => (
    <Settings
      options={chrome.allOptions()}
      section={chrome.section()}
      selected={chrome.selected()}
      groups={[...chrome.groups()]}
      prefix={chrome.prefix()}
      leader={chrome.leader()}
      conflicts={[...chrome.conflicts()]}
      capturing={chrome.capturing()}
      width={props.width}
      height={props.height}
      dirty={chrome.dirty()}
      error={chrome.error()}
      onKeybindList={(box) => {
        chrome.setKeybindList(box);
      }}
      pluginSections={chrome.pluginSections()}
      registeredOptions={chrome.registeredOptions()}
      focus={chrome.focus()}
      editText={chrome.editText()}
      onEditInput={chrome.onEditInput}
      onEditSubmit={chrome.onEditSubmit}
    />
  ),
});

export const keybindPickerPanel = (chrome: SettingsChrome): OverlayOccupant => ({
  id: "amux.keybind-picker",
  title: "keybind",
  visible: () => chrome.keybindPicker() !== null,
  component: (props) => (
    <Show when={chrome.keybindPicker()}>
      {() => (
        <KeybindPicker
          view={chrome.keybindPicker()!}
          width={props.width}
          onSubmit={() => {
            const current = chrome.keybindPicker();
            const command = current?.entries[current.selected]?.name;
            if (command && current) chrome.captureBinding(command, current.add);
          }}
          onInput={chrome.onKeybindPickerInput}
        />
      )}
    </Show>
  ),
});
