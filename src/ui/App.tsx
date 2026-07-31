/** @jsxImportSource @opentui/solid */
import { Show, createMemo } from "solid-js"
import type { BoxRenderable } from "@opentui/core"
import { Sidebar } from "./Sidebar.tsx"
import { Help, type HelpGroup } from "./Help.tsx"
import { Prompt, type PromptRequest } from "./Prompt.tsx"
import { Settings, type SettingsSection } from "./Settings.tsx"
import { theme } from "./theme.ts"
import type { AppState } from "./state.ts"
import type { Config } from "../config.ts"

export type Overlay = "none" | "help" | "settings"

export interface AppProps {
  app: AppState
  config: Config
  /** The imperative pane tree, adopted as a child so splits keep their own
   *  layout code and their cell-blitting renderables untouched. */
  paneHost: BoxRenderable
  size: { width: number; height: number }

  sidebarOpen: boolean
  sidebarFocused: boolean
  selected: number
  hovered: number | null
  onHover: (index: number | null) => void
  onActivate: (index: number) => void

  /** Key sequence in progress, e.g. ["^a"]. Drives the prefix indicator. */
  pending: string[]
  overlay: Overlay
  helpGroups: HelpGroup[]
  settingsSection: SettingsSection
  settingsSelected: number
  settingsDirty: boolean
  prompt: PromptRequest | null
}

export function App(props: AppProps) {
  const space = () => props.app.active()

  const status = createMemo(() => {
    props.app.tick()
    const agents = props.app.allAgents()
    const working = agents.filter((a) => a.state === "working").length
    const blocked = agents.filter((a) => a.state === "blocked").length
    const s = space()
    return (
      ` ${s?.name ?? "—"}${s?.branch ? ` (${s.branch})` : ""}` +
      ` · ${agents.length} agent${agents.length === 1 ? "" : "s"}` +
      ` (${working} working${blocked ? `, ${blocked} blocked` : ""})`
    )
  })

  // tmux behaviour: the header is status. A half-typed sequence only needs to
  // announce that the prefix landed — the full list lives behind ^a ?.
  const armed = () => props.pending.length > 0

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row", backgroundColor: theme.surface0 }}>
        <Show when={armed()}>
          {/* flexShrink:0 matters: the status text next to it grows, and would
              otherwise squeeze the indicator to zero columns. */}
          <text style={{ bg: theme.mauve, fg: theme.base, flexShrink: 0 }}>
            {` ${props.pending.join(" ")} `}
          </text>
        </Show>
        <text style={{ bg: theme.surface0, fg: theme.subtext0, flexGrow: 1 }}>{status()}</text>
      </box>

      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <Show when={props.sidebarOpen}>
          <Sidebar
            app={props.app}
            width={props.config.sidebar.width}
            selected={props.selected}
            hovered={props.hovered}
            focused={props.sidebarFocused}
            onHover={props.onHover}
            onActivate={props.onActivate}
          />
        </Show>
        {props.paneHost}
      </box>

      <Show when={props.overlay === "help"}>
        <Help groups={props.helpGroups} width={props.size.width} height={props.size.height} />
      </Show>
      <Show when={props.overlay === "settings"}>
        <Settings
          config={props.config}
          section={props.settingsSection}
          selected={props.settingsSelected}
          groups={props.helpGroups}
          width={props.size.width}
          height={props.size.height}
          dirty={props.settingsDirty}
        />
      </Show>
      <Show when={props.prompt} keyed>
        {(request: PromptRequest) => <Prompt request={request} width={props.size.width} />}
      </Show>
    </box>
  )
}
