import type { KeyEvent } from "@opentui/core";
import {
  keybindLine,
  keybindTargets,
  LEADER_TARGET,
  settingsFields,
  settingsSections,
} from "../../ui/Settings.tsx";
import type { OverlayService } from "../../plugin/overlay.ts";
import type { SettingsChrome } from "../../plugin/chrome.ts";

/**
 * Keys while an item is being edited (focus === "editing").
 *
 * Escape is the only key this owns for a string or number: cursor movement,
 * typing, backspace and Enter all belong to the row's own focused `<input>`,
 * so everything else returns `false` and falls through to it. A boolean has
 * no input to fall through to — there is nothing to type, only a value to
 * flip — so this claims the four directions for it directly.
 */
function settingsEditKey(
  chrome: SettingsChrome,
  overlay: OverlayService,
  event: KeyEvent,
): boolean {
  const option = chrome.selectedOption();
  const spec = option ? chrome.specFor(option) : undefined;
  if (!option || !spec) {
    chrome.setFocus("items");
    return true;
  }
  if (event.name === "escape") {
    const original = chrome.editOriginal();
    // A boolean or enum autosaves on every change (below), so undoing one has
    // to write the reversion back too — otherwise disk keeps the last change
    // while the screen shows the one from before editing.
    if (original !== null) {
      chrome.changeOption(option, original);
      if (spec.kind === "boolean" || spec.kind === "enum") chrome.saveOptions();
    }
    chrome.setEditOriginal(null);
    chrome.setEditText(undefined);
    chrome.setFocus("items");
    overlay.set("none");
    return true;
  }
  if (spec.kind === "string" || spec.kind === "number") return false;
  if (event.name === "return" || event.name === "enter") {
    chrome.setEditOriginal(null);
    chrome.setFocus("items");
    return true;
  }
  if (spec.kind === "enum") {
    // An enum has a "which way": left/up steps back through the list,
    // right/down steps forward.
    if (event.name === "left" || event.name === "up") chrome.adjustOption(option, -1);
    else if (event.name === "right" || event.name === "down") chrome.adjustOption(option, 1);
    else return true;
    chrome.saveOptions();
    return true;
  }
  // boolean: any of the four directions flips it — there is no "which way".
  if (["left", "right", "up", "down"].includes(event.name ?? "")) {
    chrome.adjustOption(option, 1);
    chrome.saveOptions();
  }
  return true;
}

function cycleSettingsSection(chrome: SettingsChrome, step: 1 | -1) {
  const sections = settingsSections(chrome.pluginSections(), chrome.registeredOptions());
  const i = sections.indexOf(chrome.section());
  chrome.setSection(sections[(i + step + sections.length) % sections.length]!);
  chrome.setSelected(0);
}

/** Move the keybind selection and keep it on screen. */
function moveKeybind(chrome: SettingsChrome, delta: number) {
  const groups = [...chrome.groups()];
  const count = keybindTargets(groups).length;
  const index = Math.max(0, Math.min(count - 1, chrome.selected() + delta));
  chrome.setSelected(index);
  const box = chrome.keybindList();
  if (!box) return;
  // The list is several screens long, so follow the selection rather than
  // leaving it to be moved off the top of a window it cannot scroll itself.
  const line = keybindLine(groups, index);
  const height = box.viewport?.height ?? box.height;
  if (line < box.scrollTop) box.scrollTop = line;
  else if (line >= box.scrollTop + height) box.scrollTop = line - height + 1;
}

function keybindsKey(chrome: SettingsChrome, event: KeyEvent) {
  const target = keybindTargets([...chrome.groups()])[chrome.selected()];
  switch (event.name) {
    case "j":
    case "down":
      return moveKeybind(chrome, 1);
    case "k":
    case "up":
      return moveKeybind(chrome, -1);
    case "pagedown":
      return moveKeybind(chrome, 10);
    case "pageup":
      return moveKeybind(chrome, -10);
    case "return":
    case "enter":
      if (target === null) return chrome.capturePrefix();
      if (target === LEADER_TARGET) return chrome.captureLeader();
      return chrome.openKeybindPicker(false);
    case "a":
      if (target === null) return chrome.capturePrefix();
      if (target === LEADER_TARGET) return chrome.captureLeader();
      return chrome.openKeybindPicker(true);
    case "u":
      return chrome.resetBinding(false);
    case "d":
      return chrome.resetBinding(true);
    case "s":
      chrome.saveSettings();
      return;
  }
}

/**
 * Whether the key was consumed here. `false` means a focused control (a
 * plugin section's own input, or the edit row's `<input>`) should receive
 * it instead — the caller must not preventDefault, or that control never
 * sees a character.
 *
 * Escape/`q` close the window from either list, but only as a default: a
 * plugin section that explicitly claims a key (returning `true`, as the
 * auth tab does to cancel out of editing rather than close) settles it
 * right there. Checking for that claim ahead of the close shortcut is what
 * keeps "cancel editing" from also closing the whole window on the same
 * keystroke. Escape from "editing" is different again — see
 * `settingsEditKey` — it undoes the value in progress rather than closing.
 */
export function settingsKey(
  chrome: SettingsChrome,
  overlay: OverlayService,
  event: KeyEvent,
): boolean {
  if (chrome.focus() === "editing") return settingsEditKey(chrome, overlay, event);

  if (chrome.focus() === "sections") {
    switch (event.name) {
      case "escape":
      case "q":
        overlay.set("none");
        return true;
      case "j":
      case "down":
        cycleSettingsSection(chrome, 1);
        return true;
      case "k":
      case "up":
        cycleSettingsSection(chrome, -1);
        return true;
      case "tab":
      case "right":
      case "return":
      case "enter":
        chrome.setFocus("items");
        return true;
    }
    return true;
  }

  // settingsFocus() === "items"
  const pluginSection = chrome.pluginSections().find((section) => section.id === chrome.section());
  if (pluginSection) {
    const handled = pluginSection.keys?.(event, chrome.selected());
    if (handled === false) return false;
    if (handled === true) return true;
    if (event.name === "escape" || event.name === "q") {
      overlay.set("none");
      return true;
    }
    if (event.name === "tab" || event.name === "left") {
      chrome.setFocus("sections");
      return true;
    }
    if (event.name === "j" || event.name === "down")
      chrome.setSelected((s) => Math.min(Math.max(0, pluginSection.rows() - 1), s + 1));
    if (event.name === "k" || event.name === "up") chrome.setSelected((s) => Math.max(0, s - 1));
    return true;
  }
  if (event.name === "escape" || event.name === "q") {
    overlay.set("none");
    return true;
  }
  if (event.name === "tab" || event.name === "left") {
    chrome.setFocus("sections");
    return true;
  }
  // The keybind tab edits sequences rather than values, so it has its own keys.
  if (chrome.section() === "keybinds") {
    keybindsKey(chrome, event);
    return true;
  }
  const fields = settingsFields(chrome.allOptions(), chrome.section(), chrome.registeredOptions());
  switch (event.name) {
    case "j":
    case "down":
      chrome.setSelected((s) => Math.min(Math.max(0, fields.length - 1), s + 1));
      return true;
    case "k":
    case "up":
      chrome.setSelected((s) => Math.max(0, s - 1));
      return true;
    case "right":
    case "return":
    case "enter": {
      const option = chrome.selectedOption();
      if (!option) return true;
      // An option whose value is chosen from a list cannot be edited in
      // place, so the row belongs to the command of the same name and
      // whoever owns the option registers it. `agent.model` is the
      // harness's; core knows only that a command with the option's name
      // exists.
      if (chrome.hasBinding(option)) {
        chrome.dispatchBinding(option);
        return true;
      }
      const spec = chrome.specFor(option);
      if (!spec || (spec.kind === "string" && !spec.editable)) return true;
      const value = chrome.optionValue(option, spec);
      chrome.setEditOriginal(value);
      chrome.setEditText(spec.kind === "number" ? String(value) : undefined);
      chrome.setFocus("editing");
      return true;
    }
    case "s":
      chrome.saveSettings();
      return true;
  }
  return true;
}

export function keybindPickerKey(chrome: SettingsChrome, event: KeyEvent): boolean {
  const view = chrome.keybindPicker();
  if (!view) return true;
  if (event.name === "escape") {
    if (view.capturing) {
      chrome.setCapturing(false);
      chrome.setKeybindPicker((current) => (current ? { ...current, capturing: false } : current));
    } else {
      chrome.setKeybindPicker(null);
    }
    return true;
  }
  if (view.capturing) return true;
  if (event.name === "j" || event.name === "down") {
    chrome.setKeybindPicker((current) =>
      current
        ? {
            ...current,
            selected: Math.min(current.entries.length - 1, current.selected + 1),
          }
        : current,
    );
    return true;
  }
  if (event.name === "k" || event.name === "up") {
    chrome.setKeybindPicker((current) =>
      current ? { ...current, selected: Math.max(0, current.selected - 1) } : current,
    );
    return true;
  }
  if (event.name === "return" || event.name === "enter") {
    const command = view.entries[view.selected]?.name;
    if (command) chrome.captureBinding(command, view.add);
    return true;
  }
  return false;
}
