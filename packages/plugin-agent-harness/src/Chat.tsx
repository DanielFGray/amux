/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree event and timer control flow belongs to OpenTUI/Solid's lifecycle, not the service Effect graph. */
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Renderable, TextareaRenderable } from "@opentui/core";
import { Option, type Stream } from "effect";
import { AttachFrame } from "@danielfgray/amux/protocol";
import type { PaneViewProps } from "@danielfgray/amux";
import { Transcript, type PermissionBlock, type QueuedPrompt } from "./Transcript.tsx";
import type { HighlightSnapshot } from "@danielfgray/amux-highlight";
import { theme } from "@danielfgray/amux";
import { ProcessState } from "@danielfgray/amux";
import type { PermissionDecision } from "@danielfgray/amux/permission.ts";
import {
  activeCompletion,
  replaceCompletion,
  type ComposerCompletion,
  type ComposerCompletionSource,
} from "./composer-completion.ts";
import { InlinePicker } from "@danielfgray/amux-plugin-completion";

export interface ChatProps extends PaneViewProps {
  model: string;
  onSlashCommand?: (command: string) => boolean;
  slashCommands?: readonly SlashCommand[];
  completionSources?: readonly ComposerCompletionSource[];
  frames: (session: string) => Stream.Stream<AttachFrame, never>;
  sync: (session: string) => void;
  /** Send what the user typed to the agent. The command layer's business: a
   *  view does not know whether the session is local or on a daemon. */
  onSubmit: (message: string, options?: PromptSubmitOptions) => void;
  /** Answer the question the agent is blocked on. */
  onPermission: (request: string, decision: PermissionDecision, feedback?: string) => void;
  /** Interrupt the active turn, including a tool currently awaiting completion. */
  onInterrupt: () => void;
  showThinking?: boolean;
  /** Highlight fenced code blocks. Absent in tests that mount views without
   *  a worker — fences then render plain. */
  highlight?: HighlightSnapshot;
}

export type PromptSubmitOptions = {
  readonly delivery?: "steer" | "queue";
  /** Rewrite this queued turn in place (edit text or flip queue→steer). */
  readonly replace?: string;
};

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
 * While this pane is focused, the composer keeps OpenTUI keyboard focus: the
 * transcript is not focusable, clicks reclaim the input, and when an overlay
 * (model picker) releases focus the composer takes it back. Focus is still
 * gated on `active` — a background pane must not eat keys meant for another —
 * and reclaim ignores a null that follows focus held by a different component
 * leaf (click-to-focus races `pane.select`).
 */
export function Chat(props: ChatProps) {
  const [draft, setDraft] = createSignal("");
  const [editorLines, setEditorLines] = createSignal(2);
  const [status, setStatus] = createSignal<ProcessState | undefined>();
  const [selectedCompletion, setSelectedCompletion] = createSignal(0);
  const [completions, setCompletions] = createSignal<readonly ComposerCompletion[]>([]);
  const [pending, setPending] = createSignal<PermissionBlock | undefined>();
  const [queued, setQueued] = createSignal<readonly QueuedPrompt[]>([]);
  const [editingTurn, setEditingTurn] = createSignal<string | undefined>();
  const [queueCursor, setQueueCursor] = createSignal(-1);
  // The request whose refusal the user is typing a reason for. While it is set,
  // the composer is a composer again and Enter sends the rejection.
  const [explaining, setExplaining] = createSignal<string | undefined>();
  const [view, setView] = createSignal<"chat" | "raw">("chat");
  let editor: TextareaRenderable | undefined;

  createEffect(() => {
    if (!props.active()) return;
    // `focused={true}` only re-runs on a prop transition; overlays that steal
    // focus leave it true, so reclaim when the renderer has no focused target.
    // Gate that reclaim: another component pane's leaf may take OpenTUI focus
    // (autoFocus on click) and then release it again while `pane.select` is
    // still in flight and this pane still reads as active — reclaiming then
    // steals the keyboard from the pane the user just clicked.
    queueMicrotask(() => editor?.focus());
    const ctx = editor?.ctx;
    if (!ctx) return;
    // ComponentPaneView mounts Solid into a box id `${paneId}-content`. A
    // focused renderable under a different `*-content` box belongs to another
    // leaf; an overlay sits outside every such box.
    const paneViewOf = (node: Renderable | null): Renderable | null => {
      let current: Renderable | null = node;
      while (current) {
        if (typeof current.id === "string" && current.id.endsWith("-content")) {
          return current.parent;
        }
        current = current.parent;
      }
      return null;
    };
    let suppressNullReclaim = false;
    const reclaim = (current: Renderable | null) => {
      if (!props.active()) return;
      if (current !== null) {
        const foreign = paneViewOf(current);
        const ours = paneViewOf(editor ?? null);
        suppressNullReclaim = foreign !== null && foreign !== ours;
        return;
      }
      if (suppressNullReclaim) {
        suppressNullReclaim = false;
        return;
      }
      queueMicrotask(() => {
        if (props.active()) editor?.focus();
      });
    };
    ctx.on("focused_renderable", reclaim);
    onCleanup(() => ctx.off("focused_renderable", reclaim));
  });

  const awaiting = () => {
    const request = pending();
    return request && explaining() !== request.request ? request : undefined;
  };

  const decide = (decision: PermissionDecision) => {
    const request = pending();
    if (request) props.onPermission(request.request, decision);
  };

  const active = createMemo(() => activeCompletion(draft()));
  const completionMenuVisible = () =>
    Option.match(active(), {
      onNone: () => false,
      onSome: () => completions().length > 0,
    });
  let completionRequest = 0;
  createEffect(() => {
    Option.match(active(), {
      onNone: () => setCompletions([]),
      onSome: (token) => {
        const source = [
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
      },
    });
  });

  const syncEditorHeight = () => {
    const paneHeight = props.height();
    const cap = Math.max(2, Math.floor(paneHeight / 2));
    // Floor of 2, not 1: a height-1 EditorView viewport never word-wraps
    // (virtualLineCount sticks at 1 and long input scrolls sideways), so a
    // one-row composer could never grow out of itself. Verified against
    // heights 1..5; heights >= 2 wrap. The numeric height wins over the
    // maxHeight yoga hint, so the signal itself carries the 50% cap —
    // otherwise a long paste would collapse the transcript entirely.
    setEditorLines(Math.min(cap, Math.max(2, editor?.virtualLineCount ?? 2)));
  };
  createEffect(() => {
    props.width();
    props.height();
    syncEditorHeight();
  });

  const submit = () => {
    const text = editor?.plainText.trim() ?? "";
    const working = status() === ProcessState.Running;
    const pendingQueue = queued();
    const editing = editingTurn();

    // Empty Enter while a turn is running promotes the latest queued prompt to
    // steer — inject at the next tool/provider boundary (Pi deliverAs:steer).
    if (!text) {
      if (!working || pendingQueue.length === 0) return;
      const last = pendingQueue[pendingQueue.length - 1]!;
      props.onSubmit(last.text, { delivery: "steer", replace: last.turn });
      setEditingTurn(undefined);
      setQueueCursor(-1);
      return;
    }

    editor?.clear();
    setDraft("");
    syncEditorHeight();
    if (editing) {
      props.onSubmit(text, { delivery: "queue", replace: editing });
    } else if (working) {
      props.onSubmit(text, { delivery: "queue" });
    } else {
      props.onSubmit(text);
    }
    setEditingTurn(undefined);
    setQueueCursor(-1);
  };

  /** Cycle a durable queued admission into the composer for edit+resubmit. */
  const recallQueued = (direction: "up" | "down"): boolean => {
    const pendingQueue = queued();
    if (pendingQueue.length === 0) return false;
    const draftEmpty = !editor?.plainText.trim();
    if (!draftEmpty && queueCursor() < 0) return false;
    const current = queueCursor();
    const next =
      direction === "up"
        ? current < 0
          ? pendingQueue.length - 1
          : Math.max(0, current - 1)
        : current < 0
          ? 0
          : Math.min(pendingQueue.length - 1, current + 1);
    const item = pendingQueue[next];
    if (!item) return false;
    editor?.setText(item.text);
    if (editor) editor.cursorOffset = item.text.length;
    setDraft(item.text);
    setEditingTurn(item.turn);
    setQueueCursor(next);
    syncEditorHeight();
    return true;
  };

  const submitEditor = () => {
    const text = editor?.plainText.trim() ?? "";
    const explained = explaining();
    if (explained !== undefined) {
      editor?.clear();
      setDraft("");
      syncEditorHeight();
      setExplaining(undefined);
      props.onPermission(explained, "reject", text || undefined);
      return;
    }
    if (text.startsWith("/") && props.onSlashCommand?.(text)) {
      editor?.clear();
      setDraft("");
      syncEditorHeight();
      return;
    }
    submit();
  };

  const selectCompletion = () => {
    const completion = completions()[selectedCompletion()];
    Option.match(active(), {
      onNone: () => {},
      onSome: (token) => {
        if (!completion) return;
        if (completion.submit && props.onSlashCommand?.(completion.replacement)) {
          editor?.clear();
          setDraft("");
          setSelectedCompletion(0);
          syncEditorHeight();
          return;
        }
        editor?.setText(replaceCompletion(draft(), token, completion.replacement));
        setDraft(editor?.plainText ?? "");
        setSelectedCompletion(0);
      },
    });
    syncEditorHeight();
  };

  return (
    <box
      style={{ width: "100%", height: "100%", flexDirection: "column" }}
      onMouseDown={(event) => {
        if (!props.active()) return;
        // Stop autoFocus from handing keyboard focus to anything else in this
        // pane (scrollbox, cards); the composer is the only typing surface.
        event.preventDefault();
        editor?.focus();
      }}
    >
      <Transcript
        sessionId={props.sessionId}
        frames={props.frames}
        sync={props.sync}
        width={props.width}
        view={view()}
        showThinking={props.showThinking}
        highlight={props.highlight}
        onStatus={setStatus}
        onQueued={setQueued}
        explaining={explaining()}
        onPending={(request) => {
          setPending(request);
          if (!request) setExplaining(undefined);
        }}
        onPermission={props.onPermission}
        onExplainPermission={(request) => setExplaining(request)}
      />
      <Show when={completionMenuVisible()}>
        <InlinePicker
          items={completions()}
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
              : status() === ProcessState.Running
                ? queued().length > 0
                  ? "↵ queue · empty ↵ steer · ↑ edit queue · ⌃C stop"
                  : "↵ queue · ⌃C stop"
                : "message the agent · ⇧↵/⌥↵ newline"
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
          if (!completionMenuVisible()) {
            // Empty Enter while running with a visible queue promotes to steer.
            // OpenTUI's submit action may skip an empty composer, so handle it here.
            if (
              (event.name === "return" || event.name === "enter") &&
              !event.shift &&
              !event.meta &&
              !editor?.plainText.trim() &&
              status() === ProcessState.Running &&
              queued().length > 0
            ) {
              submit();
              event.preventDefault();
              return;
            }
            if ((event.name === "up" || event.name === "down") && recallQueued(event.name)) {
              event.preventDefault();
            }
            return;
          }
          if (event.name === "down") {
            setSelectedCompletion((value) => Math.min(completions().length - 1, value + 1));
            event.preventDefault();
          } else if (event.name === "up") {
            setSelectedCompletion((value) => Math.max(0, value - 1));
            event.preventDefault();
            // A modified Enter is a newline (see keyBindings), never a
            // completion pick — even with the menu open.
          } else if (
            (event.name === "return" || event.name === "enter") &&
            !event.shift &&
            !event.meta
          ) {
            selectCompletion();
            event.preventDefault();
          }
        }}
        keyBindings={[
          { name: "return", action: "submit" },
          // Enter submits; Shift+Enter and Alt+Enter insert a newline. Both
          // chords are needed: the client runs with Kitty keyboard disabled
          // (main.tsx), where Shift+Return arrives indistinct from Return and
          // only the Alt chord survives the transport.
          { name: "return", shift: true, action: "newline" },
          { name: "return", meta: true, action: "newline" },
          { name: "kpenter", action: "submit" },
          { name: "kpenter", shift: true, action: "newline" },
          { name: "kpenter", meta: true, action: "newline" },
          { name: "linefeed", shift: true, action: "newline" },
          { name: "linefeed", meta: true, action: "newline" },
        ]}
        onSubmit={submitEditor}
        wrapMode="word"
        style={{
          width: "100%",
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
