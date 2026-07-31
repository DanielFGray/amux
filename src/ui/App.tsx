/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import type { BoxRenderable, Renderable } from "@opentui/core"
import type { Window } from "../window.ts"
import { Sidebar } from "./Sidebar.tsx"
import { WindowTabs } from "./WindowTabs.tsx"
import { Help, type HelpGroup } from "./Help.tsx"
import { Prompt, type PromptRequest } from "./Prompt.tsx"
import { Settings, type SettingsSection } from "./Settings.tsx"
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

  /** The draggable edge between sidebar and panes. A Divider instance rather
   *  than a component: it needs to claim the pointer on press, which only the
   *  renderable can do. */
  sidebarHandle: Renderable
  sidebarWidth: number
  sidebarOpen: boolean
  sidebarFocused: boolean
  selected: number
  hovered: number | null
  onHover: (index: number | null) => void
  onActivate: (index: number) => void

  /** Key sequence in progress, e.g. ["^a"]. Drives the prefix indicator. */
  pending: string[]
  onSelectWindow: (window: Window) => void
  overlay: Overlay
  helpGroups: HelpGroup[]
  settingsSection: SettingsSection
  settingsSelected: number
  settingsDirty: boolean
  prompt: PromptRequest | null
}

export function App(props: AppProps) {
  const space = () => props.app.active()
  const windows = () => space()?.windows ?? []

  // herdr's layout: no app-wide bar. The window list is one row at the top of
  // the pane area, beside the sidebar rather than above it. Always present, even
  // at one window — a tab bar that appears and disappears shifts the whole pane
  // area by a row, and it is where the prefix indicator lives.
  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "row" }}>
      <Show when={props.sidebarOpen}>
        <Sidebar
          app={props.app}
          width={props.sidebarWidth}
          selected={props.selected}
          hovered={props.hovered}
          focused={props.sidebarFocused}
          onHover={props.onHover}
          onActivate={props.onActivate}
        />
        {props.sidebarHandle}
      </Show>

      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        <WindowTabs
          app={props.app}
          windows={windows()}
          active={props.app.activeWindow()}
          pending={props.pending}
          onSelect={props.onSelectWindow}
        />
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
