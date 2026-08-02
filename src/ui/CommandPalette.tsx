/** @jsxImportSource @opentui/solid */
import { createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { theme } from "./theme.ts"
import type { PaletteEntry } from "../bindings.ts"

export function CommandPalette(props: {
  entries: PaletteEntry[]
  query: string
  selected: number
  width: number
  onInput: (value: string) => void
  onSubmit: () => void
}) {
  let list: ScrollBoxRenderable | undefined

  createEffect(() => {
    const box = list
    const selected = props.selected
    if (!box || selected < 0) return
    const height = box.viewport?.height ?? box.height
    if (selected < box.scrollTop) box.scrollTop = selected
    else if (selected >= box.scrollTop + height) box.scrollTop = selected - height + 1
  })

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
        zIndex: 300,
      }}
      title=" command palette "
      onMouseDown={(event) => event.stopPropagation()}
    >
      <input
        value={props.query}
        placeholder="type to filter commands"
        focused={true}
        style={{ backgroundColor: theme.surface1, textColor: theme.text, focusedTextColor: theme.text }}
        onInput={props.onInput}
        onSubmit={props.onSubmit}
      />
      <Show when={props.entries.length > 0} fallback={<text style={{ fg: theme.overlay1, height: 1 }}>no matching commands</text>}>
        <scrollbox ref={(value) => { list = value }} style={{ flexGrow: 1, flexShrink: 1 }}>
          <For each={props.entries}>
            {(entry, index) => (
              <box
                style={{
                  flexDirection: "row",
                  height: 1,
                  flexShrink: 0,
                  backgroundColor: index() === props.selected ? theme.surface1 : theme.base,
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
      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>↑↓ select · enter run · esc close</text>
    </box>
  )
}
