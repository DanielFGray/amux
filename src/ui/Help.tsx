/** @jsxImportSource @opentui/solid */
import { For } from "solid-js"
import { theme } from "./theme.ts"

export interface HelpGroup {
  group: string
  entries: { keys: string; desc: string }[]
}

/**
 * Keybind cheat sheet.
 *
 * The groups are read out of the keymap, not written here, so a rebound or
 * removed key updates this window for free. A help screen maintained alongside
 * the bindings instead of derived from them is a help screen that lies.
 */
export function Help(props: { groups: HelpGroup[]; width: number; height: number }) {
  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - 64) / 2)),
        top: 1,
        width: 64,
        maxHeight: Math.max(8, props.height - 3),
        flexDirection: "column",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.blue,
        padding: 1,
        zIndex: 200,
      }}
      title=" keybinds "
    >
      <scrollbox style={{ flexGrow: 1 }}>
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
      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
        esc or q closes · ↑↓ scrolls
      </text>
    </box>
  )
}
