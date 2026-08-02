/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show } from "solid-js"
import { SPINNER_FRAMES, STATE_GLYPH, type AgentState } from "../detect.ts"
import type { Agent } from "../agent.ts"
import type { Space } from "../space.ts"
import type { Window } from "../window.ts"
import type { AppState } from "./state.ts"
import { theme } from "./theme.ts"

export const SIDEBAR_WIDTH = 30

/** A selectable entry. Branch lines render but are never selectable, so the
 *  selection index counts only these — the keyboard and the mouse agree. */
export type SidebarTarget =
  | { kind: "space"; space: Space }
  | { kind: "window"; space: Space; window: Window }
  | { kind: "agent"; space: Space; window: Window; agent: Agent }

export function clampSidebarSelection(selected: number, count: number): number {
  return count === 0 ? 0 : Math.min(selected, count - 1)
}

type Row =
  | { kind: "space"; space: Space; index: number }
  | { kind: "branch"; space: Space }
  | { kind: "window"; space: Space; window: Window; index: number }
  | { kind: "agent"; space: Space; window: Window; agent: Agent; index: number }

/** Flatten the tree once. Used by the view and by the app's key handling, so
 *  "row 3" means the same thing to both. */
export function sidebarTargets(spaces: readonly Space[], agentsOnly = false): SidebarTarget[] {
  const out: SidebarTarget[] = []
  for (const space of spaces) {
    const windows = agentsOnly
      ? space.windows.filter((window) => window.agents.some((agent) => agent.agentKind !== null))
      : space.windows
    if (agentsOnly && windows.length === 0) continue
    out.push({ kind: "space", space })
    for (const window of windows) {
      const agents = agentsOnly ? window.agents.filter((agent) => agent.agentKind !== null) : window.agents
      out.push({ kind: "window", space, window })
      for (const agent of agents) out.push({ kind: "agent", space, window, agent })
    }
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
  agentsOnly: boolean
  /** How the toggle binding reads right now, e.g. "^a b". Passed in rather
   *  than written here, because it is rebindable. */
  toggleKeys: string
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
    if (props.agentsOnly) props.app.tick()
    const out: Row[] = []
    let index = 0
    for (const space of props.app.spaces()) {
      const windows = props.agentsOnly
        ? space.windows.filter((window) => window.agents.some((agent) => agent.agentKind !== null))
        : space.windows
      if (props.agentsOnly && windows.length === 0) continue
      out.push({ kind: "space", space, index: index++ })
      if (space.branch) out.push({ kind: "branch", space })
      for (const window of windows) {
        const agents = props.agentsOnly
          ? window.agents.filter((agent) => agent.agentKind !== null)
          : window.agents
        out.push({ kind: "window", space, window, index: index++ })
        for (const agent of agents) {
          out.push({ kind: "agent", space, window, agent, index: index++ })
        }
      }
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
      <scrollbox style={{ flexGrow: 1 }} horizontalScrollbarOptions={{ visible: false }}>
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

      {/* flexShrink 0 like the footer below it: the scrollbox above grows into
          every row it is allowed to, and a one-row summary that may shrink is a
          one-row summary that renders as nothing. */}
      <text style={{ bg: theme.surface0, fg: theme.subtext0, height: 1, flexShrink: 0 }}>
        {`${spaceCount()} space${spaceCount() === 1 ? "" : "s"} · ` +
          `${agents().length} agent${agents().length === 1 ? "" : "s"}` +
          (blocked() ? ` · ${blocked()}!` : "")}
      </text>

      <text style={{ fg: theme.subtext0, height: 1, flexShrink: 0 }}>
        {props.focused
          ? "jk select · ↵ open · x kill"
          : props.toggleKeys
            ? `${props.toggleKeys} toggles sidebar`
            : "sidebar toggle is unbound"}
      </text>
    </box>
  )
}

function SidebarRow(props: SidebarProps & { row: Exclude<Row, { kind: "branch" }> }) {
  const state = () => {
    props.app.tick()
    const row = props.row
    return row.kind === "space"
      ? row.space.state
      : row.kind === "window"
        ? row.window.state
        : row.agent.state
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

  // Marks what is on screen right now, at each level: the active space, its
  // active window, and the agent behind the focused pane.
  const marker = () => {
    const row = props.row
    if (row.kind === "space") return row.space === props.app.active() ? "▸" : " "
    if (row.kind === "window") return row.space.active === row.window ? "▸" : " "
    return props.app.focusedPane()?.agent === row.agent ? "▸" : " "
  }

  const label = () => {
    const row = props.row
    if (row.kind === "space") return row.space.name
    props.app.tick()
    // Numbered like a tmux window, because ^a 1..9 selects by that number.
    if (row.kind === "window") return row.window.label
    // What the pane used to say in its own header bar, which is gone: the tree
    // is the one place that names things now. The foreground command leads when
    // there is one, because it is the higher-value signal and a 30-col sidebar
    // truncates the tail of every row — a shell's OSC title is a long cwd the
    // space row already tells you, so it is the part that is allowed to be cut.
    const agent = row.agent
    const command = agent.foregroundCommand
    return command && !agent.title.startsWith(command) ? `${command} · ${agent.title}` : agent.title
  }

  const indicators = () => {
    if (props.row.kind !== "agent") return ""
    props.app.tick()
    const a = props.row.agent
    return (a.viewers === 0 ? "⇠" : "") + (a.unseen ? "*" : "") + (a.scrolled ? "▲" : "")
  }

  const labelColor = () => {
    const row = props.row
    if (row.kind === "space") return theme.mauve
    if (row.kind === "window") return theme.blue
    props.app.tick()
    const a = row.agent
    return a.state === "done" ? theme.overlay1 : a.unseen ? theme.peach : theme.text
  }

  // space at column 0, window indented one, agents two — the nesting is the
  // only thing telling you which window an agent belongs to.
  const indent = () => (props.row.kind === "space" ? 0 : props.row.kind === "window" ? 1 : 2)

  return (
    <box
      style={{
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        backgroundColor: background(),
        paddingLeft: indent(),
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
