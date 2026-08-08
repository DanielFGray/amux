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
  type OptionName,
  type Options,
} from "../options.ts";
import { formatKey, type Conflict, type HelpEntry, type HelpGroup } from "../bindings.ts";
import type { Info as IntegrationInfo } from "../integration.ts";

/** The option sections, plus the keybinds tab — which is not a section of the
 *  options table because a binding is not an option. */
export const SETTINGS_SECTIONS: readonly string[] = [...optionSections, "auth", "keybinds"];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** One row of the settings window. */
interface Field {
  /** What `config.set` takes, so acting on a row needs nothing but the row. */
  name: OptionName;
  /** The name without its section, which the tab above already says. */
  label: string;
  value: string;
  hint: string;
}

/**
 * The rows of a section, projected from the options table.
 *
 * Read from the live values rather than a snapshot taken when the window
 * opened, so a change made from anywhere — a key, the socket — shows here.
 */
export function settingsFields(options: Options, section: SettingsSection): Field[] {
  return optionsIn(section).map((name) => {
    const spec = OPTIONS[name];
    return {
      name,
      label: leafOf(name),
      value: formatOption(spec, options[name]),
      hint: `${spec.desc} · ${editHint(spec)}`,
    };
  });
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
  options: Options;
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
  integrations?: readonly IntegrationInfo[];
}) {
  const fields = createMemo(() => settingsFields(props.options, props.section));
  const rows = createMemo(() => keybindGroups(props.groups, props.leader));

  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - 70) / 2)),
        top: 1,
        width: 70,
        maxHeight: Math.max(10, props.height - 3),
        flexDirection: "column",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.mauve,
        padding: 1,
        zIndex: 200,
      }}
      title=" settings "
      onMouseDown={(event) => event.stopPropagation()}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        <For each={SETTINGS_SECTIONS}>
          {(section) => (
            <text
              style={{
                fg: section === props.section ? theme.base : theme.subtext0,
                bg: section === props.section ? theme.mauve : theme.base,
              }}
            >
              {` ${section} `}
            </text>
          )}
        </For>
      </box>
      <text style={{ height: 1, flexShrink: 0 }}> </text>

      <Show
        when={props.section !== "keybinds" && props.section !== "auth"}
        fallback={
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
        }
      >
        <Show when={props.section === "auth"}>
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <For each={props.integrations ?? []}>
              {(integration, i) => (
                <box style={{ flexDirection: "row", height: 1, flexShrink: 0, backgroundColor: i() === props.selected ? theme.surface1 : theme.base }}>
                  <text style={{ fg: theme.text, width: 18, flexShrink: 0 }}>{integration.label}</text>
                  <text style={{ fg: integration.connections.length ? theme.green : theme.overlay1 }}>
                    {integration.connections.length ? integration.connections.map((connection) => connection.label).join(", ") : "not connected"}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
        <Show when={props.section !== "auth"}>
         <box style={{ flexDirection: "column", flexGrow: 1 }}>
          <For each={fields()}>
            {(field, i) => (
              <box
                style={{
                  flexDirection: "row",
                  height: 1,
                  flexShrink: 0,
                  backgroundColor: i() === props.selected ? theme.surface1 : theme.base,
                }}
              >
                <text style={{ fg: theme.subtext0, width: 18, flexShrink: 0 }}>
                  {` ${field.label}`}
                </text>
                <text style={{ fg: theme.text, width: 14, flexShrink: 0 }}>{field.value}</text>
                <text style={{ fg: theme.overlay1, flexGrow: 1 }}>{field.hint}</text>
              </box>
            )}
          </For>
         </box>
        </Show>
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
          (props.section === "auth"
            ? "↑↓ provider · ⏎ connect · d disconnect · esc closes"
            : props.section !== "keybinds"
            ? "⇥ section · ↑↓ field · ←→ change · s saves · esc closes"
            : props.capturing
              ? "press the key to bind · esc cancels"
              : "↑↓ row · ⏎ rebind · a add key · u default · d unbind · s saves")}
      </text>
    </box>
  );
}
