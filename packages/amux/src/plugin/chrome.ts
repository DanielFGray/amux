import { Context } from "effect";
import type { Accessor } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { CommandSpec, Conflict, HelpGroup, HintGroup, PaletteEntry } from "../bindings.ts";
import type { OptionSpec, OptionValue, Options } from "../options.ts";
import type { Contribution } from "./contributions.ts";
import type { PluginSettingsSection } from "./types.ts";
import type { KeybindPickerView } from "../ui/KeybindPicker.tsx";
import type { PromptRequest } from "../ui/Prompt.tsx";

export type SettingsFocus = "sections" | "items" | "editing";

/**
 * Host-owned settings chrome. Survives `amux.settings` reload; the plugin
 * reads it through inject rather than closing over `buildApp` locals.
 *
 * List navigation and panel JSX live in the reloadable plugin; keybind-editor
 * ops that touch the live keymap (`capture`, rebind) stay methods here.
 */
export interface SettingsChrome {
  readonly section: Accessor<string>;
  readonly setSection: (section: string) => void;
  readonly selected: Accessor<number>;
  readonly setSelected: (value: number | ((current: number) => number)) => void;
  readonly focus: Accessor<SettingsFocus>;
  readonly setFocus: (focus: SettingsFocus) => void;
  readonly editText: Accessor<string | undefined>;
  readonly setEditText: (text: string | undefined) => void;
  readonly editOriginal: Accessor<OptionValue | null>;
  readonly setEditOriginal: (value: OptionValue | null) => void;
  readonly dirty: Accessor<boolean>;
  readonly error: Accessor<string>;
  readonly capturing: Accessor<boolean>;
  readonly setCapturing: (capturing: boolean) => void;
  readonly conflicts: Accessor<readonly Conflict[]>;
  readonly prefix: Accessor<string>;
  readonly leader: Accessor<string>;
  readonly groups: Accessor<readonly HelpGroup[]>;
  readonly allOptions: Accessor<Options & Record<string, OptionValue>>;
  readonly pluginSections: Accessor<readonly PluginSettingsSection[]>;
  readonly registeredOptions: Accessor<readonly Contribution<OptionSpec>[]>;
  readonly registeredBindings: Accessor<readonly CommandSpec[]>;
  readonly keybindPicker: Accessor<KeybindPickerView | null>;
  readonly setKeybindPicker: (
    value:
      | KeybindPickerView
      | null
      | ((current: KeybindPickerView | null) => KeybindPickerView | null),
  ) => void;
  readonly setKeybindList: (box: ScrollBoxRenderable | null) => void;
  readonly keybindList: () => ScrollBoxRenderable | null;
  readonly changeOption: (name: string, value: OptionValue) => void;
  readonly adjustOption: (name: string, by: number) => void;
  readonly saveOptions: () => void;
  readonly saveSettings: () => void;
  readonly specFor: (name: string) => OptionSpec | undefined;
  readonly selectedOption: () => string | undefined;
  readonly optionValue: (name: string, spec: OptionSpec) => OptionValue;
  readonly openKeybindPicker: (add: boolean) => void;
  readonly capturePrefix: () => void;
  readonly captureLeader: () => void;
  readonly resetBinding: (unbind: boolean) => void;
  readonly captureBinding: (command: string, add: boolean) => void;
  readonly dispatchBinding: (name: string) => void;
  readonly hasBinding: (name: string) => boolean;
  readonly onEditInput: (value: string) => void;
  readonly onEditSubmit: () => void;
  readonly onKeybindPickerInput: (query: string) => void;
}

/**
 * Command-palette + prompt / which-key chrome owned by the host so
 * `amux.commands` can reload without rebinding Solid signals in `buildApp`.
 */
export interface CommandsChrome {
  readonly query: Accessor<string>;
  readonly setQuery: (query: string) => void;
  readonly selected: Accessor<number>;
  readonly setSelected: (value: number | ((current: number) => number)) => void;
  readonly entries: Accessor<readonly PaletteEntry[]>;
  readonly submit: () => void;
  readonly prompt: Accessor<PromptRequest | null>;
  readonly promptError: Accessor<string>;
  readonly setPromptError: (error: string) => void;
  /** Human describe-key panel lines from `formatInspectResult`. */
  readonly inspectLines: Accessor<readonly string[] | null>;
  readonly clearInspect: () => void;
  /** Formatted pending-sequence label for the which-key panel. */
  readonly pending: Accessor<string>;
  readonly hintsVisible: Accessor<boolean>;
  readonly hints: Accessor<readonly HintGroup[]>;
  readonly coreBindings: () => readonly CommandSpec[];
}

/** @effect-leakable-service */
export class SettingsChromeTag extends Context.Service<SettingsChromeTag, SettingsChrome>()(
  "amux/SettingsChrome",
) {}

/** @effect-leakable-service */
export class CommandsChromeTag extends Context.Service<CommandsChromeTag, CommandsChrome>()(
  "amux/CommandsChrome",
) {}
