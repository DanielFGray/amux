/** @jsxImportSource @opentui/solid */
import { For, Show, createMemo } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { theme } from "./theme.ts"
import type { Config } from "../config.ts"
import type { HelpGroup } from "../bindings.ts"

export const SETTINGS_SECTIONS = ["sidebar", "behaviour", "keybinds"] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** One editable row. `values` drives left/right cycling; keybinds has none. */
interface Field {
  label: string
  value: string
  hint: string
}

/** Fields per section, derived from the live config so the window always shows
 *  what is actually in effect rather than a snapshot taken when it opened. */
export function settingsFields(config: Config, section: SettingsSection): Field[] {
  switch (section) {
    case "sidebar":
      return [
        { label: "Width", value: String(config.sidebar.width), hint: "columns · ←/→ adjusts" },
        { label: "Open at start", value: config.sidebar.open ? "yes" : "no", hint: "←/→ toggles" },
      ]
    case "behaviour":
      return [
        {
          label: "Scroll rows",
          value: String(config.behaviour.scrollRows),
          hint: "rows per wheel notch · ←/→ adjusts",
        },
        {
          label: "Shell",
          value: config.behaviour.shell || "$SHELL",
          hint: "used for new agents",
        },
      ]
    case "keybinds":
      return []
  }
}

/**
 * Settings, and the keybind reference on its own tab.
 *
 * There used to be a separate help window rendering exactly this list from
 * exactly this data. Two overlays showing the same thing is one overlay too
 * many to teach, so `^a ?` opens this window on the keybinds tab instead.
 */
export function Settings(props: {
  config: Config
  section: SettingsSection
  selected: number
  groups: HelpGroup[]
  width: number
  height: number
  dirty: boolean
  /** Handed the keybind list's scroll container so the app can drive it from
   *  the keyboard — the list is longer than the window by some margin. */
  onKeybindList?: (box: ScrollBoxRenderable) => void
}) {
  const fields = createMemo(() => settingsFields(props.config, props.section))

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
        when={props.section !== "keybinds"}
        fallback={
          <scrollbox style={{ flexGrow: 1 }} ref={props.onKeybindList}>
            <For each={props.groups}>
              {(group) => (
                <box style={{ flexDirection: "column", flexShrink: 0 }}>
                  <text style={{ fg: theme.mauve, height: 1, flexShrink: 0 }}>{group.group}</text>
                  <For each={group.entries}>
                    {(entry) => (
                      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
                        <text style={{ fg: theme.yellow, width: 18, flexShrink: 0 }}>
                          {`  ${entry.keys}`}
                        </text>
                        <text style={{ fg: theme.text, flexGrow: 1 }}>{entry.desc}</text>
                      </box>
                    )}
                  </For>
                  <text style={{ height: 1, flexShrink: 0 }}> </text>
                </box>
              )}
            </For>
          </scrollbox>
        }
      >
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

      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
        {(props.dirty ? "● unsaved · " : "") +
          (props.section === "keybinds"
            ? "⇥ section · ↑↓ scrolls · esc closes"
            : "⇥ section · ↑↓ field · ←→ change · s saves · esc closes")}
      </text>
    </box>
  )
}
