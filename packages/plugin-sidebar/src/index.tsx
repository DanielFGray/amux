/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo } from "solid-js";
import { Effect } from "effect";
import { theme } from "@danielfgray/amux";
import { definePlugin, type DockOccupant, type PluginDefinition } from "@danielfgray/amux";
import { OptionsTag, PanelTag, SlotsTag } from "@danielfgray/amux";
import type { SidebarDisplayRow } from "@danielfgray/amux";
import { ProcessState } from "@danielfgray/amux";
import { deriveProcessDisplay } from "@danielfgray/amux-agent-awareness/display-state.ts";
import {
  AgentAwarenessTag,
  type AgentAwarenessService,
} from "@danielfgray/amux-agent-awareness/presence.ts";
import { command } from "@danielfgray/amux";
import { formatText } from "@danielfgray/amux/format.ts";
import type { OptionSpec } from "@danielfgray/amux";

export const SIDEBAR_PLUGIN_ID = "amux.sidebar";

/** The sidebar's own option declarations, registered through `OptionsTag`. */
export const SIDEBAR_OPTIONS = {
  "sidebar.open": { kind: "boolean", default: true, desc: "show the sidebar" },
  "sidebar.width": { kind: "number", default: 30, min: 16, max: 60, desc: "columns" },
  "sidebar.agentsOnly": {
    kind: "boolean",
    default: false,
    desc: "list only panes running a recognised agent CLI",
  },
  "sidebar.format": {
    kind: "string",
    default:
      "#{?active,▸, }#{?row_kind_branch,   #{branch}#{?git_ahead, ↑#{git_ahead},}#{?git_behind, ↓#{git_behind},},#{?row_kind_space,#{space_name},#{?row_kind_window,· #{window_name},#{agent_state_glyph} #{?pane_current_command,#{pane_current_command},#{pane_title}}#{indicators}}}}",
    desc: "format for sidebar rows",
    editable: true,
  },
} as const satisfies Record<string, OptionSpec>;

export const sidebarPlugin: PluginDefinition = definePlugin({
  id: SIDEBAR_PLUGIN_ID,
  inject: [SlotsTag, OptionsTag, PanelTag, AgentAwarenessTag],
  effect: () =>
    Effect.gen(function* () {
      const slots = yield* SlotsTag;
      const options = yield* OptionsTag;
      const panelContext = yield* PanelTag;
      const awareness = yield* AgentAwarenessTag;
      yield* Effect.all(
        Object.entries(SIDEBAR_OPTIONS).map(([name, spec]) => options.register([name, spec])),
      );
      const runtime = yield* Effect.context();
      let selected = 0;
      let hovered: number | null = null;

      function activate(row: SidebarDisplayRow) {
        if (row.kind === "branch") return;
        selected = row.index;
        panelContext.setSelectedAgentId(row.agentId ?? null);

        const effect =
          row.kind === "space"
            ? panelContext.run(command("space.select", { space: row.spaceId }))
            : row.kind === "window"
              ? panelContext.run(
                  command("window.select", {
                    space: row.spaceId,
                    number: row.windowNumber!,
                  }),
                )
              : panelContext.run(command("session.reveal", { session: row.agentId! }));

        Effect.runForkWith(runtime)(
          effect.pipe(
            Effect.catch((error) => Effect.sync(() => panelContext.reportError(error.message))),
          ),
        );
      }

      const panel: DockOccupant = {
        id: SIDEBAR_PLUGIN_ID,
        title: "spaces",
        visible: () => panelContext.options()["sidebar.open"] as boolean,
        size: () => panelContext.options()["sidebar.width"] as number,
        resizable: true,
        onResize: (delta) => {
          const width = panelContext.options()["sidebar.width"] as number;
          panelContext.setOption("sidebar.width", width + delta);
        },
        component: () => (
          <SidebarView
            display={() => panelContext.display()}
            tick={() => panelContext.tick()}
            selected={() => selected}
            setSelected={(v) => {
              selected = v;
            }}
            hovered={() => hovered}
            setHovered={(v) => (hovered = v)}
            agentsOnly={() => !!panelContext.options()["sidebar.agentsOnly"]}
            format={() => panelContext.options()["sidebar.format"] as string}
            onActivate={activate}
            awareness={awareness}
          />
        ),
      };
      yield* slots.register({ slot: "left.app", occupant: panel });
    }),
});

/** Loaded from its own source like any other plugin, and so exported like one. */
export default sidebarPlugin;

export function filterRows(
  rows: readonly SidebarDisplayRow[],
  agentsOnly: boolean,
  awareness: AgentAwarenessService,
): readonly SidebarDisplayRow[] {
  if (!agentsOnly) {
    return rows.filter((r) => r.kind === "branch" || r.kind !== "agent" || !r.exited);
  }
  const isAgentCli = (row: SidebarDisplayRow) =>
    row.kind === "agent" && !!row.agentId && awareness.presence(row.agentId)?.agent != null;
  const spaceHasAgentCli = new Map<string, boolean>();
  const windowHasAgentCli = new Map<string, boolean>();
  for (const row of rows) {
    if (isAgentCli(row)) {
      spaceHasAgentCli.set(row.spaceId, true);
      windowHasAgentCli.set(row.spaceId + ":" + row.windowNumber, true);
    }
  }
  const out: SidebarDisplayRow[] = [];
  for (const row of rows) {
    if (row.kind === "space") {
      if (!spaceHasAgentCli.get(row.spaceId)) continue;
      out.push(row);
    } else if (row.kind === "branch") {
      if (!spaceHasAgentCli.get(row.spaceId)) continue;
      out.push(row);
    } else if (row.kind === "window") {
      if (!windowHasAgentCli.get(row.spaceId + ":" + row.windowNumber)) continue;
      out.push(row);
    } else if (row.kind === "agent") {
      if (!isAgentCli(row) || row.exited) continue;
      out.push(row);
    }
  }
  let index = 0;
  return out.map((row) => (row.kind === "branch" ? { ...row, index } : { ...row, index: index++ }));
}

type SelectionClamp = { readonly selected: number; readonly clamp: boolean };

function clampSelection(selected: number, rows: readonly SidebarDisplayRow[]): SelectionClamp {
  const validRows = rows.filter((r) => r.kind !== "branch");
  if (validRows.length === 0) return { selected: 0, clamp: selected !== 0 };
  const clamped = Math.min(Math.max(0, selected), validRows.length - 1);
  return { selected: clamped, clamp: clamped !== selected };
}

function SidebarView(props: {
  display: () => {
    rows: readonly SidebarDisplayRow[];
    spaceCount: number;
  };
  tick: () => number;
  selected: () => number;
  setSelected: (v: number) => void;
  hovered: () => number | null;
  setHovered: (v: number | null) => void;
  agentsOnly: () => boolean;
  format: () => string;
  onActivate: (row: SidebarDisplayRow) => void;
  awareness: AgentAwarenessService;
}) {
  const filtered = createMemo(() => {
    const d = props.display();
    props.tick();
    return { summary: d, rows: filterRows(d.rows, props.agentsOnly(), props.awareness) };
  });

  createEffect(() => {
    const result = clampSelection(props.selected(), filtered().rows);
    if (result.clamp) props.setSelected(result.selected);
  });

  const summaryText = createMemo(() => {
    props.tick();
    const d = filtered().summary;
    // Unfiltered by the agentsOnly toggle — the summary always counts the
    // whole workspace, matching what it counted before this row moved off
    // core-precomputed fields.
    const agentRows = d.rows.filter((r) => r.kind === "agent" && !r.exited);
    const blockedCount = agentRows.filter(
      (r) => r.agentId && props.awareness.presence(r.agentId)?.state === "blocked",
    ).length;
    const agentCount = agentRows.length;
    return `${d.spaceCount} space${d.spaceCount === 1 ? "" : "s"} · ${agentCount} agent${agentCount === 1 ? "" : "s"}${blockedCount ? ` · ${blockedCount}!` : ""}`;
  });

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: theme.mantle,
      }}
    >
      <scrollbox style={{ flexGrow: 1 }} horizontalScrollbarOptions={{ visible: false }}>
        <For each={filtered().rows}>
          {(row) => (
            <Show
              when={row.kind !== "branch"}
              fallback={
                <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
                  {formatText(props.format(), {
                    active: row.active,
                    row_kind_branch: true,
                    space_name: row.spaceName,
                    space_index: row.spaceIndex,
                    row_index: row.index,
                    branch: row.branch,
                    git_branch: row.branch,
                    git_ahead: row.ahead,
                    git_behind: row.behind,
                  })}
                </text>
              }
            >
              <SidebarRow
                row={row}
                selected={props.selected()}
                hovered={props.hovered()}
                onHover={props.setHovered}
                onActivate={props.onActivate}
                frame={props.tick()}
                format={props.format()}
                awareness={props.awareness}
              />
            </Show>
          )}
        </For>
      </scrollbox>
      <text style={{ bg: theme.surface0, fg: theme.subtext0, height: 1, flexShrink: 0 }}>
        {summaryText()}
      </text>
    </box>
  );
}

function SidebarRow(props: {
  row: SidebarDisplayRow;
  selected: number;
  hovered: number | null;
  onHover: (index: number | null) => void;
  onActivate: (row: SidebarDisplayRow) => void;
  frame: number;
  format: string;
  awareness: AgentAwarenessService;
}) {
  const row = props.row;
  const agentCli = () =>
    row.kind === "agent" && row.agentId
      ? (props.awareness.presence(row.agentId)?.agent ?? null)
      : null;

  const display = () =>
    row.kind === "agent" && row.agentState
      ? deriveProcessDisplay({
          session: row.agentId ?? null,
          state: row.agentState as ProcessState,
          exitCode: row.exitCode ?? null,
          detached: row.detached ?? false,
          title: row.title ?? "",
        })
      : undefined;

  const label = (): string =>
    formatText(props.format, {
      active: row.active,
      row_kind_space: row.kind === "space",
      row_kind_window: row.kind === "window",
      space_name: row.spaceName,
      space_index: row.spaceIndex,
      row_index: row.index,
      window_number: row.windowNumber,
      pane_index: row.paneIndex,
      window_name: row.windowLabel,
      pane_title: row.title,
      pane_current_command: row.foregroundCommand,
      agent_state: display()?.label,
      agent_state_label: display()?.label,
      agent_state_glyph: display()
        ? display()!.frames
          ? display()!.frames![props.frame % display()!.frames!.length]
          : display()!.glyph
        : "·",
      branch: row.branch,
      git_branch: row.branch,
      git_ahead: row.ahead,
      git_behind: row.behind,
      viewers: row.viewers,
      unseen: row.unseen,
      scrolled: row.scrolled,
      exited: row.exited,
      indicators: indicators(),
      session_kind: row.sessionKind,
      agent_cli: agentCli(),
    });

  const indicators = (): string => {
    if (row.kind !== "agent") return "";
    return (row.viewers === 0 ? "⇠" : "") + (row.unseen ? "*" : "") + (row.scrolled ? "▲" : "");
  };

  const labelColor = () => {
    if (row.kind === "space") return theme.mauve;
    if (row.kind === "window") return theme.blue;
    const state = display();
    if (!state) return theme.text;
    return state.label === "done"
      ? theme.overlay1
      : state.label === "failed"
        ? theme.red
        : row.unseen
          ? theme.peach
          : theme.text;
  };

  const indent = row.kind === "space" ? 0 : row.kind === "window" ? 1 : 2;

  return (
    <box
      style={{
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        paddingLeft: indent,
        backgroundColor:
          row.index === props.selected
            ? theme.surface1
            : row.index === props.hovered
              ? theme.overlay0
              : theme.mantle,
      }}
      onMouseDown={() => props.onActivate(row)}
      onMouseOver={() => props.onHover(row.index)}
      onMouseMove={() => props.onHover(row.index)}
      onMouseOut={() => props.onHover(null)}
    >
      <text style={{ fg: labelColor(), flexGrow: 1 }}>{label()}</text>
    </box>
  );
}
