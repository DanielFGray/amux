/** @jsxImportSource @opentui/solid */
import { createEffect, For, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { theme } from "./theme.ts";

export interface ModelPickerEntry {
  readonly value: string;
  readonly provider: string;
  readonly name: string;
  readonly description: string;
}

export interface ModelPickerView {
  readonly allEntries: readonly ModelPickerEntry[];
  readonly entries: readonly ModelPickerEntry[];
  readonly query: string;
  readonly selected: number;
}

export function ModelPicker(props: {
  readonly view: ModelPickerView;
  readonly width: number;
  readonly onInput: (query: string) => void;
  readonly onSubmit: () => void;
}) {
  let list: ScrollBoxRenderable | undefined;

  createEffect(() => {
    const box = list;
    if (!box) return;
    const selected = props.view.selected;
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
        borderColor: theme.blue,
        padding: 1,
        zIndex: 250,
      }}
      title=" choose native agent model "
      onMouseDown={(event) => event.stopPropagation()}
    >
      <input
        value={props.view.query}
        placeholder="filter models"
        focused={true}
        style={{ backgroundColor: theme.surface1, textColor: theme.text, focusedTextColor: theme.text }}
        onInput={props.onInput}
        onSubmit={props.onSubmit}
      />
      <Show
        when={props.view.entries.length > 0}
        fallback={<text style={{ fg: theme.overlay1, height: 1 }}>No catalog models available.</text>}
      >
        <scrollbox ref={(value) => (list = value)} style={{ flexGrow: 1, flexShrink: 1 }}>
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
                <text style={{ fg: theme.mauve, width: 18, flexShrink: 0 }}>{entry.provider}</text>
                <text style={{ fg: theme.text, width: 28, flexShrink: 0 }}>{entry.name}</text>
                <text style={{ fg: theme.subtext0, flexGrow: 1 }}>{entry.description}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
        ↑↓ select · enter choose · esc close
      </text>
    </box>
  );
}
