/** @jsxImportSource @opentui/solid */
import { For, Show, createMemo } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { theme } from "./theme.ts";
import {
  OPTIONS,
  editHint,
  formatOption,
  leafOf,
  optionSections,
  optionsIn,
  sectionOf,
  type Options,
  type OptionSpec,
  type OptionValue,
} from "../options.ts";
import { formatKey, type Conflict, type HelpEntry, type HelpGroup } from "../bindings.ts";
import type { PluginSettingsSection } from "../plugin/types.ts";
import type { Contribution } from "../plugin/contributions.ts";

/** The option sections, plus the keybinds tab — which is not a section of the
 *  options table because a binding is not an option. */
export const SETTINGS_SECTIONS: readonly string[] = [...optionSections, "keybinds"];
export type SettingsSection = string;

/** Width of the vertical section rail, and of the dialog as a whole — the
 *  latter is the rail plus a one-column gap plus the original 70-column
 *  content area, so existing field rows keep exactly the room they had. */
const NAV_WIDTH = 14;
const DIALOG_WIDTH = NAV_WIDTH + 1 + 70;
/** Width of a field row's label column, and what's left over for its value —
 *  `<input>` and `<text>` leaves don't shrink below their content under
 *  `flexGrow`, so the value column needs an explicit width rather than one
 *  computed by the layout. */
const LABEL_WIDTH = 18;
const VALUE_WIDTH = DIALOG_WIDTH - 2 /* dialog padding */ - NAV_WIDTH - 1 /* gap */ - LABEL_WIDTH;

export function settingsSections(
  plugins: readonly PluginSettingsSection[],
  registeredOptions: readonly Contribution<OptionSpec>[] = [],
): readonly string[] {
  const sections = new Set(optionSections);
  for (const entry of registeredOptions) sections.add(sectionOf(entry.name));
  return [...sections, ...plugins.map((plugin) => plugin.id), "keybinds"];
}

/** One row of the settings window. */
interface Field {
  /** What `config.set` takes, so acting on a row needs nothing but the row. */
  name: string;
  /** The name without its section, which the tab above already says. */
  label: string;
  value: string;
  /** The unformatted value, for the `<input>` an editing string row shows in
   *  place of `value` — `formatOption` turns an empty string into "unset",
   *  which is not what you want sitting in a text box you are about to type into. */
  raw: OptionValue;
  kind: OptionSpec["kind"];
  hint: string;
}

/**
 * The rows of a section, projected from the options table — core options plus
 * whatever a plugin has claimed through `registerOption`.
 *
 * Read from the live values rather than a snapshot taken when the window
 * opened, so a change made from anywhere — a key, the socket — shows here.
 */
export function settingsFields(
  options: Options & Record<string, OptionValue>,
  section: SettingsSection,
  registeredOptions: readonly Contribution<OptionSpec>[] = [],
): Field[] {
  const core = optionsIn(section).map((name) => {
    const spec = OPTIONS[name];
    return {
      name,
      label: leafOf(name),
      value: formatOption(spec, options[name]),
      raw: options[name],
      kind: spec.kind,
      hint: `${spec.desc} · ${editHint(spec)}`,
    };
  });
  const plugin = registeredOptions
    .filter((entry) => sectionOf(entry.name) === section)
    .map((entry) => ({
      name: entry.name,
      label: leafOf(entry.name),
      value: formatOption(entry.value, options[entry.name] ?? entry.value.default),
      raw: options[entry.name] ?? entry.value.default,
      kind: entry.value.kind,
      hint: `${entry.value.desc} · ${editHint(entry.value)}`,
    }));
  return [...core, ...plugin];
}

/**
 * A rebindable row on the keybinds tab.
 *
 * The prefix is one of them — index 0, no command behind it — because from the
 * user's side it is just another key they can change, and giving it its own
 * corner of the UI would only hide it.
 */
export interface KeybindRow {
  /** Command name, or null for the prefix row. */
  name: string | null;
  keys: string;
  desc: string;
  custom: boolean;
}

export interface KeybindGroup {
  group: string;
  /** `index` is the selection index; null for a row that cannot be edited. */
  entries: (KeybindRow & { index: number | null })[];
}

/**
 * Every row the keybind editor can land on, in display order.
 *
 * The one enumeration both the renderer and the key handler count from, so a
 * selection index cannot mean one row on screen and another when acted on.
 */
export function keybindTargets(groups: HelpGroup[]): (string | null)[] {
  return [
    null,
    ...groups.flatMap((g) =>
      g.entries.filter((e) => e.keys !== "unbound" && !e.fixed).map((e) => e.name),
    ),
  ];
}

export function keybindGroups(groups: HelpGroup[], leader: string): KeybindGroup[] {
  const targets = keybindTargets(groups);
  const row = (entry: HelpEntry) => ({
    index: entry.fixed ? null : targets.indexOf(entry.name),
    name: entry.name,
    keys: entry.keys,
    desc: entry.desc,
    custom: entry.custom,
  });
  return [
    {
      group: "prefix",
      entries: [
        {
          index: 0,
          name: null,
          keys: formatKey(leader, leader),
          desc: "prefix, pressed before every binding",
          custom: false,
        },
      ],
    },
    ...groups.map((g) => ({
      group: g.group,
      entries: g.entries.filter((entry) => entry.keys !== "unbound").map(row),
    })),
  ];
}

/**
 * Which line of the scrollable list a selection index sits on.
 *
 * The list is several screens long, so the caller keeps the selected row in
 * view — and it can only do that if it knows where the row was drawn. Mirrors
 * the layout below: one line per group heading, one per entry, one blank
 * between groups.
 */
export function keybindLine(groups: HelpGroup[], index: number): number {
  let line = 0;
  for (const group of keybindGroups(groups, "")) {
    line++;
    for (const entry of group.entries) {
      if (entry.index === index) return line;
      line++;
    }
    line++;
  }
  return 0;
}

/**
 * Settings, and the keybinds on their own tab.
 *
 * There used to be a separate help window rendering exactly this list from
 * exactly this data. Two overlays showing the same thing is one overlay too
 * many to teach, so `^a ?` opens this window on the keybinds tab instead — and
 * since the list is generated from the live keymap, the reference and the
 * editor are necessarily the same screen.
 */
export function Settings(props: {
  options: Options & Record<string, OptionValue>;
  section: SettingsSection;
  selected: number;
  groups: HelpGroup[];
  leader: string;
  /** Sequences claimed by two commands. Reported, never fatal. */
  conflicts: Conflict[];
  /** Set while waiting for the keystroke that becomes a binding. */
  capturing: boolean;
  width: number;
  height: number;
  dirty: boolean;
  /** Error from the last settings save attempt. */
  error?: string;
  /** Handed the keybind list's scroll container so the app can drive it from
   *  the keyboard — the list is longer than the window by some margin. */
  onKeybindList?: (box: ScrollBoxRenderable) => void;
  pluginSections?: readonly PluginSettingsSection[];
  registeredOptions?: readonly Contribution<OptionSpec>[];
  /** Which list has the keyboard, or whether the selected item is mid-edit. */
  focus: "sections" | "items" | "editing";
  /** Live text as a string or number item is typed into, while `focus` is
   *  "editing" — a number needs its own buffer because a value mid-typing
   *  ("-", "12.") is often not a number `formatOption`/`coerceOption` accept
   *  yet, so the box can't just show the coerced option value. */
  editText?: string;
  onEditInput: (value: string) => void;
  onEditSubmit: () => void;
}) {
  const plugin = () => props.pluginSections?.find((entry) => entry.id === props.section);
  const sections = () =>
    settingsSections(props.pluginSections ?? [], props.registeredOptions ?? []);
  const fields = createMemo(() =>
    settingsFields(props.options, props.section, props.registeredOptions ?? []),
  );
  const rows = createMemo(() => keybindGroups(props.groups, props.leader));

  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - DIALOG_WIDTH) / 2)),
        top: 1,
        width: DIALOG_WIDTH,
        maxHeight: Math.max(10, props.height - 3),
        flexDirection: "row",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.mauve,
        padding: 1,
        zIndex: 200,
      }}
      title=" settings "
      onMouseDown={(event) => event.stopPropagation()}
    >
      {/* A vertical rail rather than a single packed row of tabs: with a
          plugin registering a section per settings screen, a horizontal strip
          runs out of columns long before it runs out of sections. */}
      <box style={{ flexDirection: "column", width: NAV_WIDTH, flexShrink: 0 }}>
        <For each={sections()}>
          {(section) => {
            const active = () => section === props.section;
            // Mauve when the list itself has the keyboard; a dimmer highlight
            // once focus has moved into the item list, so the current section
            // stays visible without reading as "still navigable with ↑↓".
            const focused = () => active() && props.focus === "sections";
            return (
              <text
                style={{
                  fg: focused() ? theme.base : active() ? theme.text : theme.subtext0,
                  bg: focused() ? theme.mauve : active() ? theme.surface0 : theme.base,
                  height: 1,
                  flexShrink: 0,
                }}
              >
                {` ${section}`.padEnd(NAV_WIDTH)}
              </text>
            );
          }}
        </For>
      </box>
      <box style={{ flexDirection: "column", flexGrow: 1, marginLeft: 1 }}>
        <Show when={plugin()}>
          {(entry: () => PluginSettingsSection) =>
            entry().component({
              width: props.width,
              height: props.height,
              selected: props.selected,
            })
          }
        </Show>
        <Show when={props.section === "keybinds"}>
          <scrollbox style={{ flexGrow: 1 }} ref={props.onKeybindList}>
            <For each={rows()}>
              {(group) => (
                <box style={{ flexDirection: "column", flexShrink: 0 }}>
                  <text style={{ fg: theme.mauve, height: 1, flexShrink: 0 }}>{group.group}</text>
                  <For each={group.entries}>
                    {(entry) => {
                      const active = () => entry.index === props.selected;
                      return (
                        <box
                          style={{
                            flexDirection: "row",
                            height: 1,
                            flexShrink: 0,
                            backgroundColor: active() ? theme.surface1 : theme.base,
                          }}
                        >
                          <text style={{ fg: theme.yellow, width: 18, flexShrink: 0 }}>
                            {`  ${active() && props.capturing ? "press a key…" : entry.keys}`}
                          </text>
                          <text
                            style={{
                              fg: entry.index === null ? theme.overlay1 : theme.text,
                              flexGrow: 1,
                            }}
                          >
                            {entry.desc + (entry.custom ? " *" : "")}
                          </text>
                        </box>
                      );
                    }}
                  </For>
                  <text style={{ height: 1, flexShrink: 0 }}> </text>
                </box>
              )}
            </For>
          </scrollbox>
        </Show>
        <Show when={!plugin() && props.section !== "keybinds"}>
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <For each={fields()}>
              {(field, i) => {
                const selected = () => i() === props.selected;
                const editing = () => selected() && props.focus === "editing";
                return (
                  <box
                    style={{
                      flexDirection: "column",
                      flexShrink: 0,
                      backgroundColor: selected() ? theme.surface1 : theme.base,
                    }}
                  >
                    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
                      <text style={{ fg: theme.subtext0, width: LABEL_WIDTH, flexShrink: 0 }}>
                        {` ${field.label}`}
                      </text>
                      <Show
                        when={editing() && (field.kind === "string" || field.kind === "number")}
                        fallback={
                          <text
                            style={{
                              fg: editing() ? theme.base : theme.text,
                              bg: editing() ? theme.yellow : undefined,
                              width: VALUE_WIDTH,
                              flexShrink: 0,
                            }}
                          >
                            {field.value}
                          </text>
                        }
                      >
                        <input
                          value={
                            field.kind === "number"
                              ? (props.editText ?? String(field.raw))
                              : String(field.raw)
                          }
                          focused={true}
                          style={{
                            width: VALUE_WIDTH,
                            flexShrink: 0,
                            backgroundColor: theme.surface0,
                            textColor: theme.text,
                            focusedTextColor: theme.text,
                          }}
                          onInput={props.onEditInput}
                          onSubmit={props.onEditSubmit}
                        />
                      </Show>
                    </box>
                    {/* The hint doubles as "what does ↑↓/enter do to this row" —
                        only worth showing once the item list actually has the
                        keyboard, since it means nothing while browsing sections.
                        It sits on its own line so long hints don't compete with
                        the value column for width. */}
                    <Show when={selected() && props.focus !== "sections"}>
                      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
                        {`   ${field.hint}`}
                      </text>
                    </Show>
                  </box>
                );
              }}
            </For>
          </box>
        </Show>

        {/* A collision is not fatal — one of the two commands is simply dead — so
          it is said here rather than being allowed to stop the app. */}
        <Show when={props.section === "keybinds" && props.conflicts.length > 0}>
          <text style={{ fg: theme.red, height: 1, flexShrink: 0 }}>
            {props.conflicts
              .map((c) => `${c.sequence} → ${c.commands.join(", ")}`)
              .join(" · ")
              .slice(0, 66)}
          </text>
        </Show>
        <Show when={props.error}>
          {(error: () => string) => (
            <text style={{ fg: theme.red, height: 1, flexShrink: 0 }}>{error()}</text>
          )}
        </Show>

        <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
          {(props.dirty ? "● unsaved · " : "") +
            (props.focus === "sections"
              ? "↑↓ section · ⇥/→/⏎ open · esc closes"
              : props.focus === "editing"
                ? "esc undoes · ⏎ done"
                : plugin()
                  ? `${plugin()!.label} · ↑↓ row · ⇥/← sections · esc closes`
                  : props.section !== "keybinds"
                    ? "↑↓ field · ⏎ edit · ⇥/← sections · s saves · esc closes"
                    : props.capturing
                      ? "press the key to bind · esc cancels"
                      : "↑↓ row · ⏎ rebind · a add key · u default · d unbind · ⇥/← sections · s saves")}
        </text>
      </box>
    </box>
  );
}
