/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import type { BoxRenderable, Renderable } from "@opentui/core"
import type { Window } from "../window.ts"
import type { ScrollBoxRenderable } from "@opentui/core"
import { Sidebar } from "./Sidebar.tsx"
import { WindowTabs } from "./WindowTabs.tsx"
import { Hints } from "./Hints.tsx"
import { Prompt, type PromptRequest } from "./Prompt.tsx"
import { Capture, type CaptureView } from "./Capture.tsx"
import { Settings, type SettingsSection } from "./Settings.tsx"
import type { AppState } from "./state.ts"
import type { Config } from "../config.ts"
import type { Conflict, HelpGroup, HintGroup } from "../bindings.ts"
import type { PaletteEntry } from "../bindings.ts"
import { CommandPalette } from "./CommandPalette.tsx"

export type Overlay = "none" | "settings" | "palette"

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
  /** Whether the transient which-key panel has passed its display delay. */
  hintsVisible: boolean
  onSelectWindow: (window: Window) => void
  overlay: Overlay
  helpGroups: HelpGroup[]
  /** The prefix in effect, so the keybind list renders `<leader>` as it is
   *  currently bound rather than as it shipped. */
  leader: string
  conflicts: Conflict[]
  paletteEntries: PaletteEntry[]
  paletteQuery: string
  paletteSelected: number
  onPaletteInput: (value: string) => void
  onPaletteSubmit: () => void
  settingsSection: SettingsSection
  settingsSelected: number
  settingsDirty: boolean
  /** Error from the last settings save attempt. */
  settingsError?: string
  /** Waiting for the keystroke that becomes a binding. */
  capturing: boolean
  onKeybindList?: (box: ScrollBoxRenderable) => void
  prompt: PromptRequest | null
  captureView: CaptureView | null
  /** Compile error from the prompt's last submit, for the prompt to show. */
  promptError?: string
  /** True while the focused window's pane is in keyboard copy mode, for the
   *  tab bar's marker. */
  copying: boolean
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
      {/* Keep the sidebar slot in the root child list while toggling its width.
          Reparenting the main pane box when the sidebar returns can leave its
          first border at the old sibling geometry for one render. */}
      <box
        style={{
          width: props.sidebarOpen ? props.sidebarWidth : 0,
          height: "100%",
          flexShrink: 0,
        }}
      >
        <Show when={props.sidebarOpen}>
          <Sidebar
            app={props.app}
            width={props.sidebarWidth}
            selected={props.selected}
            hovered={props.hovered}
            focused={props.sidebarFocused}
            agentsOnly={props.config.sidebar.agentsOnly}
            onHover={props.onHover}
            onActivate={props.onActivate}
          />
        </Show>
      </box>

      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        <WindowTabs
          app={props.app}
          windows={windows()}
          active={props.app.activeWindow()}
          pending={props.pending}
          copying={props.copying}
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
      <Show when={props.hintsVisible && props.hints.length > 0 && props.overlay === "none" && !props.prompt}>
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
          leader={props.leader}
          conflicts={props.conflicts}
          capturing={props.capturing}
          width={props.size.width}
          height={props.size.height}
          dirty={props.settingsDirty}
          error={props.settingsError}
          onKeybindList={props.onKeybindList}
        />
      </Show>
      <Show when={props.overlay === "palette"}>
        <CommandPalette
          entries={props.paletteEntries}
          query={props.paletteQuery}
          selected={props.paletteSelected}
          width={props.size.width}
          onInput={props.onPaletteInput}
          onSubmit={props.onPaletteSubmit}
        />
      </Show>
      <Show when={props.prompt} keyed>
        {(request: PromptRequest) => (
          <Prompt request={request} width={props.size.width} error={props.promptError} />
        )}
      </Show>
      <Show when={props.captureView} keyed>
        {(view: CaptureView) => (
          <Capture view={view} width={props.size.width} height={props.size.height} />
        )}
      </Show>
    </box>
  )
}
