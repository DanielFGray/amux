/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import { SPINNER_FRAMES, STATE_GLYPH } from "../detect.ts";
import { AgentState } from "../agent-state.ts";
import type { Window } from "../window.ts";
import type { AppState } from "./state.ts";
import { theme } from "./theme.ts";
import { formatText } from "../format.ts";

const stateColor = (state: AgentState) =>
  state === AgentState.Blocked
    ? theme.red
    : state === AgentState.Working
      ? theme.green
      : theme.overlay1;

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
  windows: readonly Window[];
  active: Window | null;
  /** Key sequence in progress, e.g. ["^a"]. */
  pending: string[];
  /** True while the focused window's pane is in keyboard copy mode. */
  copying: boolean;
  onSelect: (window: Window) => void;
  format?: string;
  status?: string;
}) {
  const glyph = (window: Window) => {
    props.app.tick();
    const state = window.state;
    if (state !== AgentState.Working) return STATE_GLYPH[state];
    return SPINNER_FRAMES[props.app.frame() % SPINNER_FRAMES.length]!;
  };

  /** Read through the tick: an unnamed window is titled by what it is running,
   *  which arrives from the agent's OSC title after the tab first renders. */
  const label = (window: Window) => {
    props.app.tick();
    return formatText(props.format ?? "#{window_number}:#{window_name}", {
      active: window === props.active,
      window_number: window.number,
      window_name: window.title,
      zoomed: window.zoomed,
      synchronized: window.sync,
      sync: window.sync,
    });
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
              <text style={{ fg: stateColor(window.state), bg: "transparent" }}>
                {` ${glyph(window)} `}
              </text>
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
