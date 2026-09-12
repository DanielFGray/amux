/** @jsxImportSource @opentui/solid */
/**
 * Pane approval prompt — once | always | reject (and optional explain).
 *
 * Extracted from the agent-harness PermissionCard/ApprovalChoices so key
 * dispatch and agent tools share one ask UI. Core owns the chrome; callers
 * supply the request shape (verb or tool, resources, matching rule) and any
 * preview body (diffs stay harness-side via children).
 *
 * Cite: plugin-agent-harness ToolCards.ApprovalChoices; PermissionDecisionSchema.
 */
import { For, Show, type Accessor, type JSX } from "solid-js";
import type { RGBA } from "@opentui/core";
import { theme } from "./theme.ts";
import type { PermissionDecision, PermissionRule } from "../permission.ts";

/**
 * What the prompt asks about. Harness maps a permission block onto this;
 * a later command path maps a verb + resources + matched rule the same way.
 */
export type ApprovalPromptRequest = {
  /** Verb tag or tool name. */
  readonly verb: string;
  /** What the verb would touch. */
  readonly resources: readonly string[];
  /**
   * One-line description of the ask. Callers format it — harness uses
   * `bash: $ rm …`; a command path uses the verb (and args) it wants shown.
   */
  readonly summary: string;
  /**
   * Rules "always" would remember. Empty hides the always choice.
   * Cite: PermissionDecisionSchema — always is once plus a remembered rule.
   */
  readonly save: readonly PermissionRule[];
  /**
   * The rule that produced this ask, when the caller wants it shown.
   * Omitted on the harness path today so the card stays visually unchanged.
   */
  readonly rule?: PermissionRule;
};

export type ApprovalPromptProps = {
  request: ApprovalPromptRequest;
  width: number | Accessor<number>;
  /** Composer owns the deny-with-reason path; hide choices while it does. */
  explaining?: boolean;
  /** Orphan asks (no tool card) get surface0 chrome around the bordered box. */
  framed?: boolean;
  onDecide: (decision: PermissionDecision) => void;
  /** Absent → no explain choice (command asks that cannot take free-text deny). */
  onExplain?: () => void;
  /** Optional preview between the summary and the choices (e.g. DiffBlock). */
  children?: JSX.Element;
};

/**
 * The ask a pane shows for an agent tool or a constrained command.
 *
 * Keep this short: transcript sticky-scrolls to the bottom, so a tall choice
 * list would push the primary [o] action above the visible fold.
 */
export function ApprovalPrompt(props: ApprovalPromptProps) {
  return (
    <Show
      when={props.framed}
      fallback={<ApprovalPromptInner {...props} />}
    >
      <box
        style={{
          width: "100%",
          flexShrink: 0,
          flexDirection: "column",
          marginTop: 1,
          marginBottom: 1,
          backgroundColor: theme.surface0,
        }}
      >
        <ApprovalPromptInner {...props} />
      </box>
    </Show>
  );
}

function ApprovalPromptInner(props: ApprovalPromptProps) {
  return (
    <Show
      when={!props.explaining}
      fallback={<text style={{ height: 1, fg: theme.yellow }}>awaiting approval</text>}
    >
      <ApprovalChoicesBody {...props} />
    </Show>
  );
}

function ApprovalChoicesBody(props: ApprovalPromptProps) {
  const choices = () => {
    const rows: {
      key: string;
      label: string;
      color: RGBA;
      run: () => void;
    }[] = [
      { key: "o", label: "once", color: theme.green, run: () => props.onDecide("once") },
    ];
    if (props.request.save.length > 0) {
      rows.push({
        key: "a",
        label: "always",
        color: theme.green,
        run: () => props.onDecide("always"),
      });
    }
    rows.push({
      key: "d",
      label: "deny",
      color: theme.red,
      run: () => props.onDecide("reject"),
    });
    if (props.onExplain !== undefined) {
      rows.push({
        key: "e",
        label: "explain",
        color: theme.red,
        run: props.onExplain,
      });
    }
    return rows;
  };

  const alwaysRule =
    props.request.save.length > 0
      ? props.request.save.map((rule) => `${rule.action} ${rule.resource}`).join(", ")
      : undefined;
  const matchedRule = (() => {
    const rule = props.request.rule;
    if (rule === undefined) return undefined;
    return `${rule.effect} → ${rule.action} ${rule.resource}`;
  })();

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
        {props.request.summary}
      </text>
      <Show when={matchedRule}>
        <text style={{ wrapMode: "word", width: "100%", fg: theme.overlay1 }}>
          {matchedRule}
        </text>
      </Show>
      <Show when={alwaysRule}>
        <text style={{ wrapMode: "word", width: "100%", fg: theme.overlay1 }}>
          {`always → ${alwaysRule}`}
        </text>
      </Show>
      {props.children}
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <For each={choices()}>
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
