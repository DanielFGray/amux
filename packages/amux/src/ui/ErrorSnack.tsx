/** @jsxImportSource @opentui/solid */
import { theme } from "./theme.ts";

/** Cap so a long message never stretches across the whole terminal. */
const MAX_SNACK_WIDTH = 48;
const MIN_SNACK_WIDTH = 28;

export function snackWidth(available: number): number {
  return Math.min(MAX_SNACK_WIDTH, Math.max(MIN_SNACK_WIDTH, available - 2));
}

/** Fit one line of copy inside the bordered snack (padding + borders). */
export function truncateSnackMessage(message: string, width: number): string {
  const inner = Math.max(1, width - 4);
  if (message.length <= inner) return message;
  if (inner <= 1) return "…";
  return `${message.slice(0, inner - 1)}…`;
}

/**
 * Compact command-error toast. Not an overlay: sits in the float plane so it
 * does not own the key context of a modal and does not span the full width.
 * "show more" opens OpenTUI's built-in console (already capturing console.*).
 */
export function ErrorSnack(props: {
  message: string;
  left: number;
  width: number;
  onClose: () => void;
  onShowMore: () => void;
}) {
  const width = () => snackWidth(props.width);
  const left = () => props.left + Math.max(0, props.width - width() - 1);

  return (
    <box
      style={{
        position: "absolute",
        left: left(),
        bottom: 1,
        width: width(),
        height: 4,
        flexDirection: "column",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.red,
        paddingLeft: 1,
        paddingRight: 1,
        zIndex: 200,
      }}
      title=" error "
      onMouseDown={(event) => event.stopPropagation()}
    >
      <text style={{ fg: theme.red, height: 1, flexShrink: 0 }}>
        {truncateSnackMessage(props.message, width())}
      </text>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        <box style={{ flexShrink: 0, height: 1 }} onMouseDown={props.onClose}>
          <text style={{ fg: theme.overlay1 }}>close</text>
        </box>
        <text style={{ fg: theme.overlay0 }}> · </text>
        <box style={{ flexShrink: 0, height: 1 }} onMouseDown={props.onShowMore}>
          <text style={{ fg: theme.yellow }}>show more</text>
        </box>
      </box>
    </box>
  );
}
