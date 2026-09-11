/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree; OpenTUI owns layout. */
/**
 * Per-tool chat cards — OpenCode `ToolPart` Switch + pi `core/tools/renderers/*`.
 *
 * Presentation only: headlines come from `toolFaces` / `toolSummary`; bodies are
 * tool-specific (bash preview, mutation diffs, headline-only reads). Raw
 * `transcriptLine` is unchanged.
 */
import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  type Accessor,
  type JSX,
} from "solid-js";
import { theme } from "@danielfgray/amux";
import type { PermissionDecision } from "@danielfgray/amux/permission.ts";
import {
  permissionSummary,
  toolOutput,
  toolSummary,
  type TranscriptBlock,
} from "./transcript.ts";
import { DiffBlock } from "./DiffBlock.tsx";
import { splitUnifiedDiffs } from "./diff-view.ts";

export type ToolBlock = Extract<TranscriptBlock, { kind: "tool" }>;
type PermissionBlock = Extract<TranscriptBlock, { kind: "permission" }>;

export type ToolCardProps = {
  block: ToolBlock;
  permission?: PermissionBlock;
  explaining?: boolean;
  onDecide?: (decision: PermissionDecision) => void;
  onExplain?: () => void;
  width: Accessor<number>;
  expanded: boolean;
  onToggle?: () => void;
};

/** Dispatch by tool name — cite: opencode session `ToolPart` Switch. */
export function ToolCard(props: ToolCardProps) {
  const name = () => props.block.name;
  return (
    <Switch fallback={<OutputToolCard {...props} mode="error-only" />}>
      <Match when={name() === "bash"}>
        <OutputToolCard {...props} mode="bash" />
      </Match>
      <Match when={name() === "edit" || name() === "write" || name() === "apply_patch"}>
        <MutationToolCard {...props} />
      </Match>
      <Match when={name() === "read" || name() === "grep" || name() === "glob"}>
        <HeadlineToolCard {...props} />
      </Match>
    </Switch>
  );
}

/**
 * Text-output tools: bash always shows a collapsed preview; unknown tools only
 * surface output on error (success stays headline-only).
 */
function OutputToolCard(props: ToolCardProps & { mode: "bash" | "error-only" }) {
  const block = () => props.block;
  const output = () => {
    const raw = toolOutput(block())?.trim();
    if (raw === undefined || raw === "") return undefined;
    if (props.mode === "error-only" && !block().isError) return undefined;
    return raw;
  };
  const collapsed = createMemo(() => collapseOutput(output() ?? "", 10));
  const expandable = createMemo(() => collapsed().overflow);
  const visible = createMemo(() =>
    props.expanded || !collapsed().overflow ? output() : collapsed().text,
  );

  return (
    <ToolCardFrame
      {...props}
      expandable={expandable()}
      body={
        <Show when={output()}>
          <text
            style={{
              wrapMode: "word",
              width: "100%",
              fg: block().isError ? theme.red : theme.overlay1,
            }}
          >
            {visible()}
          </text>
        </Show>
      }
    />
  );
}

/** edit / write / apply_patch: title + unified diffs (opencode Edit / pi edit). */
function MutationToolCard(props: ToolCardProps) {
  const block = () => props.block;
  const toolDiffs = createMemo(() => {
    const raw = toolOutput(block());
    return raw === undefined ? ([] as const) : splitUnifiedDiffs(raw);
  });
  const expandable = createMemo(() => toolDiffs().length > 3);
  const visibleDiffs = createMemo(() => {
    const all = toolDiffs();
    if (props.expanded || all.length <= 3) return all;
    return all.slice(0, 3);
  });

  return (
    <ToolCardFrame
      {...props}
      expandable={expandable()}
      body={
        <For each={[...visibleDiffs()]}>
          {(diff) => <DiffBlock diff={diff} width={props.width} />}
        </For>
      }
    />
  );
}

/**
 * read / grep / glob: headline only in chat (path/pattern is the body).
 * Ranged-read titles and previews are ts-6be02d.
 */
function HeadlineToolCard(props: ToolCardProps) {
  return <ToolCardFrame {...props} expandable={false} body={undefined} />;
}

function ToolCardFrame(
  props: ToolCardProps & {
    expandable: boolean;
    body?: JSX.Element;
  },
) {
  const block = () => props.block;
  const headline = createMemo(() => toolSummary(block()));

  return (
    <box
      style={{
        width: "100%",
        flexShrink: 0,
        flexDirection: "column",
        marginTop: 1,
      }}
      onMouseUp={props.expandable ? props.onToggle : undefined}
    >
      <text
        style={{
          height: 1,
          fg: block().streaming ? theme.overlay1 : block().isError ? theme.red : theme.subtext0,
        }}
      >
        {headline()}
      </text>
      {props.body}
      <Show
        when={
          props.permission !== undefined &&
          props.permission.decision === undefined &&
          !props.explaining
        }
      >
        <ApprovalChoices
          request={props.permission!}
          width={props.width}
          onDecide={(decision) => props.onDecide?.(decision)}
          onExplain={() => props.onExplain?.()}
        />
      </Show>
      <Show when={props.permission?.decision === undefined && props.explaining}>
        <text style={{ height: 1, fg: theme.yellow }}>awaiting approval</text>
      </Show>
      <Show when={props.expandable}>
        <text style={{ height: 1, fg: theme.overlay1 }}>
          {props.expanded ? "click to collapse" : "click to expand"}
        </text>
      </Show>
    </box>
  );
}

type CollapsedOutput = { readonly text: string; readonly overflow: boolean };

function collapseOutput(output: string, maxLines: number): CollapsedOutput {
  const lines = output.split("\n");
  if (lines.length <= maxLines) return { text: output, overflow: false };
  return { text: `${lines.slice(0, maxLines).join("\n")}\n...`, overflow: true };
}

/** Shared by tool cards and orphan permission cards. */
export function ApprovalChoices(props: {
  request: PermissionBlock;
  width: Accessor<number>;
  onDecide: (decision: PermissionDecision) => void;
  onExplain: () => void;
}) {
  // Keep this short: the transcript sticky-scrolls to the bottom, so a tall
  // choice list would push the primary [o] action above the visible fold.
  const choices = [
    { key: "o", label: "once", color: theme.green, run: () => props.onDecide("once") },
    ...(props.request.save.length > 0
      ? [
          {
            key: "a",
            label: "always",
            color: theme.green,
            run: () => props.onDecide("always"),
          },
        ]
      : []),
    { key: "d", label: "deny", color: theme.red, run: () => props.onDecide("reject") },
    { key: "e", label: "explain", color: theme.red, run: props.onExplain },
  ];
  const alwaysRule =
    props.request.save.length > 0
      ? props.request.save.map((rule) => `${rule.action} ${rule.resource}`).join(", ")
      : undefined;
  const previewDiffs = createMemo(() => {
    if (props.request.diff === undefined) return [] as const;
    const parts = splitUnifiedDiffs(props.request.diff);
    return parts.length > 0 ? parts : [props.request.diff];
  });

  return (
    <box
      style={{
        width: "100%",
        flexDirection: "column",
        flexShrink: 0,
        marginTop: 1,
        backgroundColor: theme.mantle,
        border: true,
        borderColor: theme.yellow,
      }}
    >
      <text style={{ wrapMode: "word", width: "100%", fg: theme.text }}>
        {permissionSummary(props.request)}
      </text>
      <Show when={alwaysRule}>
        <text style={{ wrapMode: "word", width: "100%", fg: theme.overlay1 }}>
          {`always → ${alwaysRule}`}
        </text>
      </Show>
      <For each={[...previewDiffs()]}>
        {(diff) => <DiffBlock diff={diff} width={props.width} />}
      </For>
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <For each={choices}>
          {(choice) => (
            <box
              style={{ height: 1, flexShrink: 0, flexDirection: "row", marginRight: 2 }}
              onMouseUp={choice.run}
            >
              <text style={{ fg: theme.mauve }}>{`[${choice.key}]`}</text>
              <text style={{ fg: choice.color }}>{` ${choice.label}`}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  );
}
