/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import { ProcessState } from "../process-state.ts";
import type { Window } from "../window.ts";
import type {
  ProcessDisplayReader,
  ProcessDisplayResult,
} from "../plugin/process-display.ts";
import type { AppState } from "./state.ts";
import { theme } from "./theme.ts";
import { formatText } from "../format.ts";

/** Most urgent display among a window's sessions — the tab-row equivalent of
 *  `space.ts`'s core `rollUp`, but over whatever richer vocabulary
 *  `processDisplay` derives (e.g. failed/detached), never a value core names. */
function windowDisplay(window: Window, processDisplay: ProcessDisplayReader): ProcessDisplayResult {
  let best: ProcessDisplayResult | undefined;
  for (const session of window.sessions) {
    const result = processDisplay.display({
      state: session.state,
      exitCode: session.exitCode,
      detached: session.detached,
    });
    if (!best || result.rank > best.rank) best = result;
  }
  return best ?? processDisplay.display({ state: window.state, exitCode: null, detached: false });
}

/**
 * The window list, herdr-style: a single row at the top of the pane area rather
 * than an app-wide status bar, so it sits beside the sidebar instead of above
 * it.
 *
 * Also carries the prefix indicator, which needs to live somewhere now that
 * there is no global bar to put it in.
 */
export function WindowTabs(props: {
  app: AppState;
  processDisplay: ProcessDisplayReader;
  windows: readonly Window[];
  active: Window | null;
  /** Key sequence in progress, e.g. ["^a"]. */
  pending: string[];
  /** True while the focused window's pane is in keyboard copy mode. */
  copying: boolean;
  onSelect: (window: Window) => void;
  format?: string;
  status?: string;
  spaceIndex?: number;
  spaceName?: string;
  branch?: string;
  gitAhead?: number;
  gitBehind?: number;
}) {
  /** Read through the tick: an unnamed window is titled by what it is running,
   *  which arrives from the agent's OSC title after the tab first renders. */
  const label = (window: Window) => {
    props.app.tick();
    const session = window.focused?.session;
    const display = windowDisplay(window, props.processDisplay);
    return formatText(
      props.format ??
        "#{agent_state_glyph} #{window_number}:#{window_name}#{?zoomed, Z,}#{?synchronized, Y,}",
      {
        active: window === props.active,
        space_index: props.spaceIndex,
        space_name: props.spaceName,
        window_number: window.number,
        window_name: window.title,
        zoomed: window.zoomed,
        synchronized: window.sync,
        sync: window.sync,
        pane_index: session ? window.sessions.indexOf(session) : undefined,
        pane_title: session?.title,
        pane_current_command: session?.foregroundCommand,
        agent_state: display.label,
        agent_state_label: display.label,
        agent_state_glyph: display.frames
          ? display.frames[props.app.frame() % display.frames.length]
          : display.glyph,
        scrolled: session?.scrolled,
        exited: session?.exited,
        viewers: session?.viewers,
        unseen: session?.unseen,
        branch: props.branch,
        git_branch: props.branch,
        git_ahead: props.gitAhead,
        git_behind: props.gitBehind,
      },
    );
  };

  return (
    <box
      style={{
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        backgroundColor: theme.mantle,
      }}
    >
      <For each={props.windows}>
        {(window) => {
          const active = () => window === props.active;
          return (
            <box
              style={{
                flexShrink: 0,
                flexDirection: "row",
                height: 1,
                backgroundColor: active() ? theme.surface1 : theme.mantle,
              }}
              onMouseDown={() => props.onSelect(window)}
            >
              <text
                style={{
                  fg: active() ? theme.text : theme.overlay1,
                  bg: "transparent",
                }}
              >
                {`${label(window)} `}
              </text>
            </box>
          );
        }}
      </For>

      {/* Fills the rest of the row so the tabs stay left-aligned. */}
      <box style={{ flexGrow: 1, height: 1, backgroundColor: theme.mantle }} />

      <Show when={props.status}>
        <text style={{ fg: theme.subtext0, bg: theme.mantle, flexShrink: 0 }}>
          {` ${props.status} `}
        </text>
      </Show>

      <Show when={props.copying}>
        <text style={{ bg: theme.green, fg: theme.base, flexShrink: 0 }}> copy </text>
      </Show>

      <Show when={props.pending.length > 0}>
        <text style={{ bg: theme.mauve, fg: theme.base, flexShrink: 0 }}>
          {` ${props.pending.join(" ")} `}
        </text>
      </Show>
    </box>
  );
}
