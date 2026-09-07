/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree event and timer control flow belongs to OpenTUI/Solid's lifecycle, not the service Effect graph. */
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";
import type { Stream } from "effect";
import { AttachFrame } from "@danielfgray/amux/protocol";
import type { PaneViewProps } from "@danielfgray/amux";
import { Transcript, type PermissionBlock } from "./Transcript.tsx";
import { permissionSummary } from "./transcript.ts";
import { theme } from "@danielfgray/amux";
import { ProcessState } from "@danielfgray/amux";
import type { PermissionDecision } from "@danielfgray/amux/permission.ts";
import {
  activeCompletion,
  replaceCompletion,
  type ComposerCompletion,
  type ComposerCompletionSource,
} from "./composer-completion.ts";

export interface ChatProps extends PaneViewProps {
  model: string;
  onSlashCommand?: (command: string) => boolean;
  slashCommands?: readonly SlashCommand[];
  completionSources?: readonly ComposerCompletionSource[];
  frames: (session: string) => Stream.Stream<AttachFrame, never>;
  sync: (session: string) => void;
  /** Send what the user typed to the agent. The command layer's business: a
   *  view does not know whether the session is local or on a daemon. */
  onSubmit: (message: string) => void;
  /** Answer the question the agent is blocked on. */
  onPermission: (request: string, decision: PermissionDecision, feedback?: string) => void;
  /** Interrupt the active turn, including a tool currently awaiting completion. */
  onInterrupt: () => void;
  showThinking?: boolean;
}

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

/**
 * A conversation with a native agent: what a component pane mounts.
 *
 * The transcript takes what is left after the composer, so the composer sits on
 * the last row of the pane at every size — a chat window's shape, not a panel's.
 *
 * The composer only holds OpenTUI's keyboard focus while its own pane is the
 * focused one. Focus is renderer-wide, so an input left focused in a background
 * pane would eat the keystrokes meant for whatever pane the user moved to.
 */
export function Chat(props: ChatProps) {
  const [draft, setDraft] = createSignal("");
  const [editorLines, setEditorLines] = createSignal(1);
  const [status, setStatus] = createSignal<ProcessState | undefined>();
  const [selectedCompletion, setSelectedCompletion] = createSignal(0);
  const [completions, setCompletions] = createSignal<readonly ComposerCompletion[]>([]);
  const [pending, setPending] = createSignal<PermissionBlock | undefined>();
  // The request whose refusal the user is typing a reason for. While it is set,
  // the composer is a composer again and Enter sends the rejection.
  const [explaining, setExplaining] = createSignal<string | undefined>();
  const [view, setView] = createSignal<"chat" | "raw">("chat");
  let editor: TextareaRenderable | undefined;

  const awaiting = () => {
    const request = pending();
    return request && explaining() !== request.request ? request : undefined;
  };

  const decide = (decision: PermissionDecision) => {
    const request = pending();
    if (request) props.onPermission(request.request, decision);
  };

  const active = createMemo(() => activeCompletion(draft()));
  const completionMenuVisible = () => active() !== undefined && completions().length > 0;
  let completionRequest = 0;
  createEffect(() => {
    const token = active();
    const source =
      token &&
      [
        ...(props.slashCommands === undefined
          ? []
          : [
              {
                trigger: "/" as const,
                complete: (query: string) =>
                  props
                    .slashCommands!.filter((command) =>
                      `${command.name} ${command.description}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((command) => ({
                      id: command.name,
                      label: `/${command.name}`,
                      detail: command.description,
                      replacement: `/${command.name}`,
                      submit: true,
                    })),
              },
            ]),
        ...(props.completionSources ?? []),
      ].find((candidate) => candidate.trigger === token.trigger);
    if (!source) {
      setCompletions([]);
      return;
    }
    const request = ++completionRequest;
    void Promise.resolve(source.complete(token.query)).then((items) => {
      if (request === completionRequest) setCompletions(items);
    });
  });

  const syncEditorHeight = () => setEditorLines(Math.max(1, editor?.virtualLineCount ?? 1));
  createEffect(() => {
    props.width();
    syncEditorHeight();
  });

  const submit = () => {
    const text = editor?.plainText.trim() ?? "";
    editor?.clear();
    setDraft("");
    if (text) props.onSubmit(text);
  };

  const submitEditor = () => {
    const text = editor?.plainText.trim() ?? "";
    const explained = explaining();
    if (explained !== undefined) {
      editor?.clear();
      setDraft("");
      setExplaining(undefined);
      props.onPermission(explained, "reject", text || undefined);
      return;
    }
    if (text.startsWith("/") && props.onSlashCommand?.(text)) {
      editor?.clear();
      setDraft("");
      return;
    }
    submit();
  };

  const selectCompletion = () => {
    const completion = completions()[selectedCompletion()];
    const token = active();
    if (!completion || !token) return;
    if (completion.submit && props.onSlashCommand?.(completion.replacement)) {
      editor?.clear();
      setDraft("");
      setSelectedCompletion(0);
      return;
    }
    editor?.setText(replaceCompletion(draft(), token, completion.replacement));
    setDraft(editor?.plainText ?? "");
    setSelectedCompletion(0);
  };

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
      <Transcript
        sessionId={props.sessionId}
        frames={props.frames}
        sync={props.sync}
        width={props.width}
        model={props.model}
        view={view()}
        showThinking={props.showThinking}
        onStatus={setStatus}
        onPending={(request) => {
          setPending(request);
          if (!request) setExplaining(undefined);
        }}
      />
      <Show when={awaiting()}>
        {(request: () => PermissionBlock) => (
          <ApprovalBar
            request={request()}
            onDecide={decide}
            onExplain={() => setExplaining(request().request)}
          />
        )}
      </Show>
      <Show when={completionMenuVisible()}>
        <CompletionPicker
          completions={completions()}
          selected={selectedCompletion()}
          onSelect={selectCompletion}
          onSelectedChange={setSelectedCompletion}
        />
      </Show>
      <textarea
        ref={(value) => (editor = value)}
        placeholder={
          awaiting()
            ? "o once · a always · d deny · e deny with a reason"
            : explaining()
              ? "why not? enter sends the refusal"
              : "message the agent"
        }
        focused={props.active()}
        onContentChange={() => {
          setDraft(editor?.plainText ?? "");
          setSelectedCompletion(0);
          syncEditorHeight();
        }}
        onKeyDown={(event) => {
          if (event.ctrl && event.name === "c") {
            props.onInterrupt();
            event.preventDefault();
            return;
          }
          // A blocked agent owns the keyboard: nothing the user types is a
          // message until the question in front of them is answered.
          if (awaiting()) {
            if (event.name === "o") decide("once");
            else if (event.name === "a") decide("always");
            else if (event.name === "d") decide("reject");
            else if (event.name === "e") setExplaining(pending()?.request);
            event.preventDefault();
            return;
          }
          if (event.ctrl && event.name === "t") {
            setView((current) => (current === "chat" ? "raw" : "chat"));
            event.preventDefault();
            return;
          }
          if (!completionMenuVisible()) return;
          if (event.name === "down") {
            setSelectedCompletion((value) => Math.min(completions().length - 1, value + 1));
            event.preventDefault();
          } else if (event.name === "up") {
            setSelectedCompletion((value) => Math.max(0, value - 1));
            event.preventDefault();
          } else if (event.name === "return" || event.name === "enter") {
            selectCompletion();
            event.preventDefault();
          }
        }}
        keyBindings={[{ name: "return", action: "submit" }]}
        onSubmit={submitEditor}
        style={{
          height: editorLines(),
          maxHeight: "50%",
          flexShrink: 0,
          backgroundColor: props.active() ? theme.surface1 : theme.surface0,
          textColor: theme.text,
          focusedTextColor: theme.text,
        }}
      />
      <StatusBar model={props.model} working={status() === ProcessState.Running} view={view()} />
    </box>
  );
}

/**
 * The question, the rule that answering "always" would write, and the four ways
 * to answer it. The rule is shown rather than described: "always" is a choice
 * about a pattern, and a pattern the user cannot read is not a choice.
 */
function ApprovalBar(props: {
  request: PermissionBlock;
  onDecide: (decision: PermissionDecision) => void;
  onExplain: () => void;
}) {
  const choices = [
    { key: "o", label: "once", color: theme.green, run: () => props.onDecide("once") },
    ...(props.request.save.length > 0
      ? [
          {
            key: "a",
            label: `always (${props.request.save.map((rule) => `${rule.action} ${rule.resource}`).join(", ")})`,
            color: theme.green,
            run: () => props.onDecide("always"),
          },
        ]
      : []),
    { key: "d", label: "deny", color: theme.red, run: () => props.onDecide("reject") },
    { key: "e", label: "deny with a reason", color: theme.red, run: props.onExplain },
  ];

  return (
    <box
      style={{
        width: "100%",
        flexDirection: "column",
        flexShrink: 0,
        backgroundColor: theme.mantle,
        border: true,
        borderColor: theme.yellow,
      }}
    >
      <text style={{ wrapMode: "word", width: "100%", fg: theme.text }}>
        {permissionSummary(props.request)}
      </text>
      <For each={choices}>
        {(choice) => (
          <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }} onMouseUp={choice.run}>
            <text style={{ width: 4, flexShrink: 0, fg: theme.mauve }}>{`[${choice.key}]`}</text>
            <text style={{ flexGrow: 1, fg: choice.color }}>{choice.label}</text>
          </box>
        )}
      </For>
    </box>
  );
}

function CompletionPicker(props: {
  completions: readonly ComposerCompletion[];
  selected: number;
  onSelect: () => void;
  onSelectedChange: (selected: number) => void;
}) {
  return (
    <box
      style={{
        width: "100%",
        maxHeight: 8,
        flexDirection: "column",
        backgroundColor: theme.mantle,
        border: true,
        borderColor: theme.surface1,
        flexShrink: 0,
      }}
    >
      <For each={props.completions}>
        {(completion, index) => (
          <box
            style={{
              height: 1,
              flexShrink: 0,
              flexDirection: "row",
              backgroundColor: index() === props.selected ? theme.surface1 : theme.mantle,
            }}
            onMouseUp={() => {
              props.onSelectedChange(index());
              props.onSelect();
            }}
          >
            <text style={{ width: 28, flexShrink: 0, fg: theme.mauve }}>{completion.label}</text>
            <text style={{ flexGrow: 1, fg: theme.subtext0 }}>{completion.detail}</text>
          </box>
        )}
      </For>
    </box>
  );
}

function StatusBar(props: { model: string; working: boolean; view: "chat" | "raw" }) {
  return (
    <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
      <text
        style={{ flexGrow: 1, fg: theme.overlay1 }}
      >{`${props.model} · ${props.view} · ^t`}</text>
      <Show when={props.working}>
        <WorkingSpinner />
      </Show>
    </box>
  );
}

function WorkingSpinner() {
  const frames = ["·", "✦", "·", "✧"];
  const [frame, setFrame] = createSignal(0);
  const timer = setInterval(() => setFrame((value) => (value + 1) % frames.length), 350);
  onCleanup(() => clearInterval(timer));

  return (
    <text style={{ height: 1, flexShrink: 0, fg: theme.overlay1 }}>
      {() => `${frames[frame()]} working`}
    </text>
  );
}
