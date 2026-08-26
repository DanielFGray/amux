/** @jsxImportSource @opentui/solid */
import { For, createMemo } from "solid-js";
import { theme } from "./theme.ts";
import type { HintGroup } from "../bindings.ts";

/** Widest group name we will indent to before the layout starts looking silly. */
const MAX_LABEL = 10;
/** Gap between two entries on the same line. */
const GAP = "   ";

interface Line {
  label: string;
  entries: { keys: string; desc: string }[];
}

/** Decide the visible/delayed state before the app arms its timer. */
export function hintVisibility(sequenceLength: number, enabled: boolean, delaySeconds: number) {
  if (sequenceLength === 0 || !enabled) return { visible: false, delayMs: 0 };
  const delayMs = Math.max(0, delaySeconds) * 1000;
  return { visible: delayMs === 0, delayMs };
}

/**
 * Pack a group's entries into lines that fit, keeping each entry whole.
 *
 * Done here rather than by letting text wrap: an entry split across a line
 * break reads as two commands, and the whole point of the panel is that you can
 * scan it in the half second before you press the next key.
 */
function wrap(group: HintGroup, label: string, width: number): Line[] {
  const lines: Line[] = [];
  let current: Line["entries"] = [];
  let used = 0;

  for (const entry of group.entries) {
    // Not "/" — one of the keys *is* "/", and "?//" is unreadable.
    const keys = entry.keys.join("·");
    const size = keys.length + 1 + entry.desc.length;
    if (current.length && used + GAP.length + size > width) {
      lines.push({ label: lines.length ? "" : label, entries: current });
      current = [];
      used = 0;
    }
    used += (current.length ? GAP.length : 0) + size;
    current.push({ keys, desc: entry.desc });
  }
  if (current.length) lines.push({ label: lines.length ? "" : label, entries: current });
  return lines;
}

/**
 * The which-key panel: what the half-typed sequence can still become.
 *
 * An overlay rather than part of the layout, and deliberately so — a panel that
 * took a row from the pane area would resize every pane, and resizing a pane
 * resizes its pty, so every child would reflow its screen twice per prefix
 * press. Transient chrome must never touch the layout of a terminal.
 */
export function Hints(props: {
  groups: HintGroup[];
  /** The sequence so far, e.g. "^a". */
  pending: string;
  left: number;
  width: number;
  height: number;
}) {
  const labelWidth = createMemo(() =>
    Math.min(MAX_LABEL, Math.max(0, ...props.groups.map((g) => g.group.length))),
  );

  const lines = createMemo(() => {
    // 2 for the border, 2 for the padding, then the label gutter.
    const available = Math.max(20, props.width - 4 - labelWidth() - 1);
    return props.groups.flatMap((group) => wrap(group, group.group.slice(0, MAX_LABEL), available));
  });

  return (
    <box
      style={{
        position: "absolute",
        left: props.left,
        top: 1,
        width: props.width,
        maxHeight: Math.max(4, props.height - 2),
        flexDirection: "column",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.mauve,
        paddingLeft: 1,
        paddingRight: 1,
        zIndex: 150,
      }}
      title={` ${props.pending} `}
    >
      <For each={lines()}>
        {(line) => (
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
            <text style={{ fg: theme.mauve, width: labelWidth() + 1, flexShrink: 0 }}>
              {line.label}
            </text>
            <For each={line.entries}>
              {(entry, i) => (
                <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
                  <text style={{ fg: theme.overlay1 }}>{i() ? GAP : ""}</text>
                  <text style={{ fg: theme.yellow }}>{entry.keys}</text>
                  <text style={{ fg: theme.text }}>{` ${entry.desc}`}</text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}
