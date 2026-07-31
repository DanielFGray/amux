/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import type { BoxRenderable, Renderable } from "@opentui/core"
import type { Window } from "../window.ts"
import type { ScrollBoxRenderable } from "@opentui/core"
import { Sidebar } from "./Sidebar.tsx"
import { WindowTabs } from "./WindowTabs.tsx"
import { Hints } from "./Hints.tsx"
import { Prompt, type PromptRequest } from "./Prompt.tsx"
import { Settings, type SettingsSection } from "./Settings.tsx"
import type { AppState } from "./state.ts"
import type { Config } from "../config.ts"
import type { HelpGroup, HintGroup } from "../bindings.ts"

export type Overlay = "none" | "settings"

export interface AppProps {
  app: AppState
  config: Config
  /** The imperative pane tree, adopted as a child so splits keep their own
   *  layout code and their cell-blitting renderables untouched. */
  paneHost: BoxRenderable
  size: { width: number; height: number }

  /** The draggable edge between sidebar and panes, which doubles as the pane
   *  frame's left border. A Divider instance rather than a component: it needs
   *  to claim the pointer on press, which only the renderable can do. */
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
  /** What that sequence can still become. Empty unless one is in progress. */
  hints: HintGroup[]
  onSelectWindow: (window: Window) => void
  overlay: Overlay
  helpGroups: HelpGroup[]
  settingsSection: SettingsSection
  settingsSelected: number
  settingsDirty: boolean
  onKeybindList?: (box: ScrollBoxRenderable) => void
  prompt: PromptRequest | null
}

export function App(props: AppProps) {
  const space = () => props.app.active()
  const windows = () => space()?.windows ?? []
  /** Where the pane area starts, so transient chrome lines up with it rather
   *  than covering the tree. */
  const paneLeft = () => (props.sidebarOpen ? props.sidebarWidth : 0)

  // herdr's layout: no app-wide bar. The window list is one row at the top of
  // the pane area, beside the sidebar rather than above it. Always present, even
  // at one window — a tab bar that appears and disappears shifts the whole pane
  // area by a row, and it is where the prefix indicator lives.
  //
  // The sidebar handle sits *below* the tab row rather than beside it, because
  // it is the pane frame's left border: it has to start and end exactly where
  // the frame does, or its corners land in the wrong cells.
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
      </Show>

      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        <WindowTabs
          app={props.app}
          windows={windows()}
          active={props.app.activeWindow()}
          pending={props.pending}
          onSelect={props.onSelectWindow}
        />
        <box style={{ flexGrow: 1, flexDirection: "row" }}>
          <Show when={props.sidebarOpen}>{props.sidebarHandle}</Show>
          {props.paneHost}
        </box>
      </box>

      {/* Only while a sequence is half-typed, and never over a modal — an
          overlay that is already answering "what now?" does not need a second
          one on top of it. */}
      <Show when={props.hints.length > 0 && props.overlay === "none" && !props.prompt}>
        <Hints
          groups={props.hints}
          pending={props.pending.join(" ")}
          left={paneLeft()}
          width={props.size.width - paneLeft()}
          height={props.size.height}
        />
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
          onKeybindList={props.onKeybindList}
        />
      </Show>
      <Show when={props.prompt} keyed>
        {(request: PromptRequest) => <Prompt request={request} width={props.size.width} />}
      </Show>
    </box>
  )
}
