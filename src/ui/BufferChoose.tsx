/** @jsxImportSource @opentui/solid */
import { createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { theme } from "./theme.ts"
import type { BufferEntry } from "../effect/BufferStore.ts"

/** The choose-buffer overlay's state, held by the app like CaptureView's. */
export interface BufferChooseView {
  /** The stack as the daemon listed it, top first. */
  buffers: BufferEntry[]
  selected: number
  /** Paste the selected buffer into the focused pane, then close. */
  onPaste: (name: string) => void
  /** Delete the selected buffer and refresh the list. */
  onDelete: (name: string) => void
  onClose: () => void
}

/**
 * tmux's choose-buffer: a list of the server-side paste buffer stack, pick
 * with ↑↓, Enter pastes into the focused pane, d deletes, escape closes. The
 * stack is whatever the daemon holds — it is not the client's clipboard, and
 * it survives this terminal closing.
 */
export function BufferChoose(props: { view: BufferChooseView; width: number; height: number }) {
  const width = () => Math.min(Math.max(46, props.width - 6), 100)
  let list: ScrollBoxRenderable | undefined

  createEffect(() => {
    const box = list
    const selected = props.view.selected
    if (!box || selected < 0) return
    const height = box.viewport?.height ?? box.height
    if (selected < box.scrollTop) box.scrollTop = selected
    else if (selected >= box.scrollTop + height) box.scrollTop = selected - height + 1
  })

  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - width()) / 2)),
        top: 1,
        width: width(),
        maxHeight: props.height - 2,
        flexDirection: "column",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.mauve,
        padding: 1,
        zIndex: 260,
      }}
      title=" choose buffer "
      onMouseDown={(event) => event.stopPropagation()}
    >
      <text style={{ fg: theme.mauve, height: 1, flexShrink: 0 }}>
        the stack lives on the server, so it survives detach
      </text>
      <text style={{ height: 1, flexShrink: 0 }}> </text>
      <Show
        when={props.view.buffers.length > 0}
        fallback={<text style={{ fg: theme.overlay1, height: 1 }}>no buffers — copy something first</text>}
      >
        <scrollbox
          ref={(value) => { list = value }}
          style={{ flexGrow: 1, flexShrink: 1, backgroundColor: theme.mantle }}
        >
          <For each={props.view.buffers}>
            {(buffer, index) => (
              <box
                style={{
                  flexDirection: "row",
                  height: 1,
                  flexShrink: 0,
                  backgroundColor: index() === props.view.selected ? theme.surface1 : theme.mantle,
                }}
              >
                <text style={{ fg: theme.mauve, width: 6, flexShrink: 0 }}>{buffer.name}</text>
                <text style={{ fg: theme.subtext0, width: 8, flexShrink: 0 }}>{buffer.bytes} b</text>
                <text style={{ fg: theme.text, flexGrow: 1 }}>
                  {buffer.preview || "(empty)"}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
        ↑↓ select · enter paste · d delete · esc close
      </text>
    </box>
  )
}
