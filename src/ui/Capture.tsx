/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import { theme } from "./theme.ts"
import type { CaptureSpan } from "../capture.ts"

export interface CaptureView {
  title: string
  content: string
  path: string
  /** What `content` is a capture of; `f` re-captures the other span. */
  span: CaptureSpan
  /** True once the file has been written to `path`. */
  saved: boolean
  onToggleSpan: () => void
  onSave: () => void
  onClose: () => void
}

/** Rows captured, counting lines the way the terminal would: an empty capture
 *  has none. */
const rowCount = (content: string) => (content === "" ? 0 : content.split("\n").length)

/**
 * The destination of a pane capture.
 *
 * Capturing is deliberately two steps, tmux's capture-pane followed by
 * save-buffer: the popup shows exactly what will be written, and `s` writes it
 * to the shown path. Closing without saving discards the buffer — the terminal
 * itself was never touched.
 */
export function Capture(props: { view: CaptureView; width: number; height: number }) {
  const width = () => Math.min(Math.max(40, props.width - 6), 110)
  const bodyHeight = () => Math.max(4, Math.min(props.height - 5, 20))
  const rows = () => rowCount(props.view.content)
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
        borderColor: theme.green,
        padding: 1,
        zIndex: 250,
      }}
      title=" capture "
    >
      <text style={{ fg: theme.green, height: 1, flexShrink: 0 }}>{props.view.title}</text>
      <text style={{ height: 1, flexShrink: 0 }}> </text>
      <box style={{ flexGrow: 1, flexDirection: "column", backgroundColor: theme.mantle }}>
        <text style={{ fg: theme.text, height: bodyHeight(), flexShrink: 0 }}>
          {props.view.content}
        </text>
      </box>
      <text style={{ fg: theme.subtext0, height: 1, flexShrink: 0 }}>
        <Show
          when={props.view.saved}
          fallback={`${rows()} rows · ${props.view.span} · will save to ${props.view.path}`}
        >
          {`saved ${rows()} rows to ${props.view.path}`}
        </Show>
      </text>
      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
        {props.view.saved ? "esc closes" : "s saves · f toggles span · esc discards"}
      </text>
    </box>
  )
}
