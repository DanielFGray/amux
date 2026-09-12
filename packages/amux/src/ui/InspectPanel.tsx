/** @jsxImportSource @opentui/solid */
import { For } from "solid-js";
import { theme } from "./theme.ts";
import { snackWidth } from "./ErrorSnack.tsx";

/** Multi-line float for `app.describe-key` — same plane as the error snack. */
export function InspectPanel(props: {
  lines: readonly string[];
  left: number;
  width: number;
  onClose: () => void;
}) {
  const width = () => Math.min(64, Math.max(snackWidth(props.width), props.width - 2));
  const left = () => props.left + Math.max(0, props.width - width() - 1);
  const height = () => Math.min(12, Math.max(3, props.lines.length + 2));

  return (
    <box
      style={{
        position: "absolute",
        left: left(),
        bottom: 1,
        width: width(),
        height: height(),
        flexDirection: "column",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.blue,
        paddingLeft: 1,
        paddingRight: 1,
        zIndex: 200,
      }}
      title=" describe "
      onMouseDown={(event) => event.stopPropagation()}
    >
      <For each={[...props.lines]}>
        {(line) => (
          <text style={{ fg: theme.text, height: 1, flexShrink: 0 }}>
            {line.length > width() - 4 ? `${line.slice(0, Math.max(1, width() - 5))}…` : line}
          </text>
        )}
      </For>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        <box style={{ flexShrink: 0, height: 1 }} onMouseDown={props.onClose}>
          <text style={{ fg: theme.overlay1 }}>esc close</text>
        </box>
      </box>
    </box>
  );
}
