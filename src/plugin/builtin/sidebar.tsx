/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo } from "solid-js";
import { Effect, Runtime } from "effect";
import { theme } from "../../ui/theme.ts";
import type { DockPanel } from "../../ui/regions.tsx";
import { definePlugin, type PluginDefinition } from "../types.ts";
import { OptionsTag, ProcessDisplayTag, RegionsTag } from "../services.ts";
import type { SidebarDisplayRow } from "../../ui/panel.ts";
import { SPINNER_FRAMES } from "../../detect.ts";
import { ProcessState } from "../../process-state.ts";
import { deriveProcessDisplay } from "./agent-awareness/display-state.ts";
import { command } from "../../commands.ts";
import { formatText } from "../../format.ts";
import type { OptionSpec } from "../../options.ts";

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
  apiVersion: "1",
  inject: [RegionsTag, OptionsTag, ProcessDisplayTag],
  effect: (ctx) =>
    Effect.gen(function* () {
      const regions = yield* RegionsTag;
      const options = yield* OptionsTag;
      const processDisplay = yield* ProcessDisplayTag;
      yield* Effect.all(
        Object.entries(SIDEBAR_OPTIONS).map(([name, spec]) => options.register([name, spec])),
      );
      // The one registration that lets core's WindowTabs show failed/detached
      // without importing plugin code — see plugin/process-display.ts.
      yield* processDisplay.register(deriveProcessDisplay);
      const runtime = yield* Effect.runtime();
      let selected = 0;
      let hovered: number | null = null;

      function activate(row: SidebarDisplayRow) {
        if (row.kind === "branch") return;
        selected = row.index;
        ctx.panel.setSelectedAgentId(row.agentId ?? null);

        const effect =
          row.kind === "space"
            ? ctx.panel.run(command("space.select", { space: row.spaceId }))
            : row.kind === "window"
              ? ctx.panel.run(
                  command("window.select", {
                    space: row.spaceId,
                    number: row.windowNumber!,
                  }),
                )
              : ctx.panel.run(command("session.reveal", { session: row.agentId! }));

        Runtime.runFork(runtime)(
          effect.pipe(
            Effect.catchAll((error) => Effect.sync(() => ctx.panel.reportError(error.message))),
          ),
        );
      }

      const panel: DockPanel = {
        id: SIDEBAR_PLUGIN_ID,
        region: "left",
        anchor: "app",
        title: "spaces",
        visible: () => ctx.panel.options()["sidebar.open"] as boolean,
        size: () => ctx.panel.options()["sidebar.width"] as number,
        resizable: true,
        onResize: (delta) => {
          const width = ctx.panel.options()["sidebar.width"] as number;
          ctx.panel.setOption("sidebar.width", width + delta);
        },
        component: () => (
          <SidebarView
            display={() => ctx.panel.display()}
            tick={() => ctx.panel.tick()}
            selected={() => selected}
            setSelected={(v) => {
              selected = v;
            }}
            hovered={() => hovered}
            setHovered={(v) => (hovered = v)}
            agentsOnly={() => !!ctx.panel.options()["sidebar.agentsOnly"]}
            format={() => ctx.panel.options()["sidebar.format"] as string}
            onActivate={activate}
          />
        ),
      };
      yield* regions.register(panel);
    }),
});

/** Loaded from its own source like any other plugin, and so exported like one. */
export default sidebarPlugin;

function filterRows(
  rows: readonly SidebarDisplayRow[],
  agentsOnly: boolean,
): readonly SidebarDisplayRow[] {
  if (!agentsOnly) {
    return rows.filter((r) => r.kind === "branch" || r.kind !== "agent" || !r.exited);
  }
  const spaceHasAgentCli = new Map<string, boolean>();
  const windowHasAgentCli = new Map<string, boolean>();
  for (const row of rows) {
    if (row.kind === "agent" && row.agentCliKind !== null) {
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
      if (row.agentCliKind === null || row.exited) continue;
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
    agentCount: number;
    blockedCount: number;
  };
  tick: () => number;
  selected: () => number;
  setSelected: (v: number) => void;
  hovered: () => number | null;
  setHovered: (v: number | null) => void;
  agentsOnly: () => boolean;
  format: () => string;
  onActivate: (row: SidebarDisplayRow) => void;
}) {
  const filtered = createMemo(() => {
    const d = props.display();
    props.tick();
    return { summary: d, rows: filterRows(d.rows, props.agentsOnly()) };
  });

  createEffect(() => {
    const result = clampSelection(props.selected(), filtered().rows);
    if (result.clamp) props.setSelected(result.selected);
  });

  const summaryText = createMemo(() => {
    props.tick();
    const d = filtered().summary;
    return `${d.spaceCount} space${d.spaceCount === 1 ? "" : "s"} · ${d.agentCount} agent${d.agentCount === 1 ? "" : "s"}${d.blockedCount ? ` · ${d.blockedCount}!` : ""}`;
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
}) {
  const row = props.row;

  const display = () =>
    row.kind === "agent" && row.agentState
      ? deriveProcessDisplay({
          state: row.agentState as ProcessState,
          exitCode: row.exitCode ?? null,
          detached: row.detached ?? false,
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
        ? row.agentState === ProcessState.Running
          ? SPINNER_FRAMES[props.frame % SPINNER_FRAMES.length]
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
      session_kind: row.agentSessionKind,
      agent_cli: row.agentCliKind,
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
