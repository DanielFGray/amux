/** @jsxImportSource @opentui/solid */
import { Show, createMemo } from "solid-js"
import type { BoxRenderable } from "@opentui/core"
import type { Window } from "../window.ts"
import { Sidebar } from "./Sidebar.tsx"
import { WindowTabs } from "./WindowTabs.tsx"
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
  // the pane area, beside the sidebar rather than above it. Hidden when a
  // single window makes it pure decoration.
  const showTabs = () => windows().length > 1

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "row" }}>
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

      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        <Show
          when={showTabs()}
          fallback={
            // With one window there is no list worth showing, but the prefix
            // indicator still needs somewhere to live.
            <Show when={props.pending.length > 0}>
              <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
                <box style={{ flexGrow: 1, height: 1, backgroundColor: theme.mantle }} />
                <text style={{ bg: theme.mauve, fg: theme.base, flexShrink: 0 }}>
                  {` ${props.pending.join(" ")} `}
                </text>
              </box>
            </Show>
          }
        >
          <WindowTabs
            app={props.app}
            windows={windows()}
            active={props.app.activeWindow()}
            pending={props.pending}
            onSelect={props.onSelectWindow}
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
