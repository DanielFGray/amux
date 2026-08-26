/** @jsxImportSource @opentui/solid */
import { createEffect, For, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { theme } from "./theme.ts";
import type { PaletteEntry } from "../bindings.ts";

/** Keep available actions prominent without reshuffling either group. */
export function sortKeybindEntries(entries: PaletteEntry[]): PaletteEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        Number(a.entry.keys !== "unbound") - Number(b.entry.keys !== "unbound") ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

export interface KeybindPickerView {
  entries: PaletteEntry[];
  query: string;
  selected: number;
  add: boolean;
  capturing: boolean;
  error: string;
  available: string[];
}

export function KeybindPicker(props: {
  view: KeybindPickerView;
  width: number;
  onInput: (query: string) => void;
  onSubmit: () => void;
}) {
  let list: ScrollBoxRenderable | undefined;

  createEffect(() => {
    const box = list;
    const selected = props.view.selected;
    if (!box) return;
    const height = box.viewport?.height ?? box.height;
    if (selected < box.scrollTop) box.scrollTop = selected;
    else if (selected >= box.scrollTop + height) box.scrollTop = selected - height + 1;
  });

  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - 78) / 2)),
        top: 1,
        width: 78,
        maxHeight: 18,
        flexDirection: "column",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.green,
        padding: 1,
        zIndex: 250,
      }}
      title={props.view.capturing ? " choose key " : props.view.add ? " add keybind " : " rebind "}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Show
        when={!props.view.capturing}
        fallback={
          <>
            <text style={{ fg: theme.yellow, height: 1 }}>press an unused key for the action</text>
            <Show when={props.view.available.length > 0}>
              <text style={{ fg: theme.overlay1, height: 1 }}>
                {`unused: ${props.view.available.join(" ")}`}
              </text>
            </Show>
            <Show when={props.view.error.length > 0}>
              <text style={{ fg: theme.red, height: 1 }}>{props.view.error}</text>
            </Show>
          </>
        }
      >
        <input
          value={props.view.query}
          placeholder="filter actions"
          focused={true}
          style={{
            backgroundColor: theme.surface1,
            textColor: theme.text,
            focusedTextColor: theme.text,
          }}
          onInput={props.onInput}
          onSubmit={props.onSubmit}
        />
        <scrollbox
          ref={(value) => {
            list = value;
          }}
          style={{ flexGrow: 1, flexShrink: 1 }}
        >
          <For each={props.view.entries}>
            {(entry, index) => (
              <box
                style={{
                  flexDirection: "row",
                  height: 1,
                  flexShrink: 0,
                  backgroundColor: index() === props.view.selected ? theme.surface1 : theme.base,
                }}
              >
                <text style={{ fg: theme.mauve, width: 11, flexShrink: 0 }}>{entry.group}</text>
                <text style={{ fg: theme.yellow, width: 18, flexShrink: 0 }}>{entry.keys}</text>
                <text style={{ fg: theme.text, width: 25, flexShrink: 0 }}>{entry.name}</text>
                <text style={{ fg: theme.subtext0, flexGrow: 1 }}>{entry.desc}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
        {props.view.capturing
          ? "esc cancel · unused keys only"
          : "↑↓ select · enter choose · esc close"}
      </text>
    </box>
  );
}
