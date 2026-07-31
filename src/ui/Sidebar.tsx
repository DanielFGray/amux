/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show } from "solid-js"
import { SPINNER_FRAMES, STATE_GLYPH, type AgentState } from "../detect.ts"
import type { Agent } from "../agent.ts"
import type { Space } from "../space.ts"
import type { AppState } from "./state.ts"
import { theme } from "./theme.ts"

export const SIDEBAR_WIDTH = 30

/** A selectable entry. Branch lines render but are never selectable, so the
 *  selection index counts only these — the keyboard and the mouse agree. */
export type SidebarTarget =
  | { kind: "space"; space: Space }
  | { kind: "agent"; space: Space; agent: Agent }

type Row =
  | { kind: "space"; space: Space; index: number }
  | { kind: "branch"; space: Space }
  | { kind: "agent"; space: Space; agent: Agent; index: number }

/** Flatten the tree once. Used by the view and by the app's key handling, so
 *  "row 3" means the same thing to both. */
export function sidebarTargets(spaces: readonly Space[]): SidebarTarget[] {
  const out: SidebarTarget[] = []
  for (const space of spaces) {
    out.push({ kind: "space", space })
    for (const agent of space.agents) out.push({ kind: "agent", space, agent })
  }
  return out
}

const stateColor = (state: AgentState) =>
  state === "blocked" ? theme.red : state === "working" ? theme.green : theme.overlay1

export interface SidebarProps {
  app: AppState
  width: number
  selected: number
  hovered: number | null
  focused: boolean
  onHover: (index: number | null) => void
  onActivate: (index: number) => void
}

/**
 * The space/agent tree.
 *
 * Against the imperative version this replaces: no #dirty flag, no
 * invalidate(), no requestRender(), and no hand-maintained row model. Reading
 * `app.tick()` where polled state is displayed is the whole repaint mechanism.
 */
export function Sidebar(props: SidebarProps) {
  const rows = createMemo(() => {
    const out: Row[] = []
    let index = 0
    for (const space of props.app.spaces()) {
      out.push({ kind: "space", space, index: index++ })
      if (space.branch) out.push({ kind: "branch", space })
      for (const agent of space.agents) out.push({ kind: "agent", space, agent, index: index++ })
    }
    return out
  })

  const agents = () => props.app.allAgents()
  const blocked = () => {
    props.app.tick()
    return agents().filter((a) => a.state === "blocked").length
  }
  const spaceCount = () => props.app.spaces().length

  return (
    <box
      style={{
        width: props.width,
        flexShrink: 0,
        flexDirection: "column",
        backgroundColor: theme.mantle,
      }}
    >
      <text style={{ bg: theme.surface0, fg: theme.subtext0, height: 1 }}>
        {`${spaceCount()} space${spaceCount() === 1 ? "" : "s"} · ` +
          `${agents().length} agent${agents().length === 1 ? "" : "s"}` +
          (blocked() ? ` · ${blocked()}!` : "")}
      </text>

      <scrollbox style={{ flexGrow: 1 }}>
        <For each={rows()}>
          {(row) => (
            <Show
              when={row.kind !== "branch"}
              fallback={
                <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
                  {"   " +
                    row.space.branch +
                    (row.space.ahead ? ` ↑${row.space.ahead}` : "") +
                    (row.space.behind ? ` ↓${row.space.behind}` : "")}
                </text>
              }
            >
              <SidebarRow {...props} row={row as Exclude<Row, { kind: "branch" }>} />
            </Show>
          )}
        </For>
      </scrollbox>

      <text style={{ fg: theme.subtext0, height: 1, flexShrink: 0 }}>
        {props.focused ? "jk select · ↵ open · x kill" : "^a b toggles sidebar"}
      </text>
    </box>
  )
}

function SidebarRow(props: SidebarProps & { row: Exclude<Row, { kind: "branch" }> }) {
  const state = () => {
    props.app.tick()
    return props.row.kind === "space" ? props.row.space.state : props.row.agent.state
  }

  const glyph = () => {
    const s = state()
    if (s !== "working") return STATE_GLYPH[s]
    return SPINNER_FRAMES[props.app.frame() % SPINNER_FRAMES.length]!
  }

  const background = () =>
    props.row.index === props.selected
      ? theme.surface1
      : props.row.index === props.hovered
        ? theme.overlay0
        : theme.mantle

  // Marks what is on screen right now: the active space, and within it the
  // agent behind the focused pane.
  const marker = () =>
    props.row.kind === "space"
      ? props.row.space === props.app.active()
        ? "▸"
        : " "
      : props.app.focusedPane()?.agent === props.row.agent
        ? "▸"
        : " "

  const label = () => {
    if (props.row.kind === "space") return props.row.space.name
    props.app.tick()
    return props.row.agent.title
  }

  const indicators = () => {
    if (props.row.kind !== "agent") return ""
    props.app.tick()
    const a = props.row.agent
    return (a.viewers === 0 ? "⇠" : "") + (a.unseen ? "*" : "") + (a.scrolled ? "▲" : "")
  }

  const labelColor = () => {
    if (props.row.kind === "space") return theme.mauve
    props.app.tick()
    const a = props.row.agent
    return a.state === "done" ? theme.overlay1 : a.unseen ? theme.peach : theme.text
  }

  return (
    <box
      style={{
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        backgroundColor: background(),
        paddingLeft: props.row.kind === "agent" ? 1 : 0,
      }}
      onMouseDown={() => props.onActivate(props.row.index)}
      // "over" fires once on entry and every position after that is "move";
      // handling both is what keeps the highlight tracking the pointer.
      onMouseOver={() => props.onHover(props.row.index)}
      onMouseMove={() => props.onHover(props.row.index)}
      onMouseOut={() => props.onHover(null)}
    >
      <text style={{ fg: theme.blue }}>{marker()}</text>
      <text style={{ fg: stateColor(state()) }}>{glyph()}</text>
      <text style={{ fg: labelColor(), flexGrow: 1 }}>{` ${label()}`}</text>
      <text style={{ fg: labelColor() }}>{indicators()}</text>
    </box>
  )
}
