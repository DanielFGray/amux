/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";
import type { Stream } from "effect";
import type { AttachFrame } from "../../../effect/AttachProtocol.ts";
import type { PaneViewProps } from "../../../component-pane.tsx";
import { Transcript } from "./Transcript.tsx";
import { theme } from "../../../ui/theme.ts";
import { AgentState, type ReportedAgentState } from "../../../agent-state.ts";

export interface ChatProps extends PaneViewProps {
  model: string;
  onSlashCommand?: (command: string) => boolean;
  slashCommands?: readonly SlashCommand[];
  frames: (session: string) => Stream.Stream<AttachFrame, unknown>;
  sync: (session: string) => void;
  /** Send what the user typed to the agent. The command layer's business: a
   *  view does not know whether the session is local or on a daemon. */
  onSubmit: (message: string) => void;
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
  const [status, setStatus] = createSignal<ReportedAgentState | undefined>();
  const [selectedCommand, setSelectedCommand] = createSignal(0);
  let editor: TextareaRenderable | undefined;

  const commands = createMemo(() => {
    const query = draft().slice(1).trimStart().toLowerCase();
    return (props.slashCommands ?? []).filter((command) =>
      `${command.name} ${command.description}`.toLowerCase().includes(query),
    );
  });
  const commandMenuVisible = () => draft().startsWith("/") && commands().length > 0;

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
    if (text.startsWith("/") && props.onSlashCommand?.(text)) {
      editor?.clear();
      setDraft("");
      return;
    }
    submit();
  };

  const selectCommand = () => {
    const command = commands()[selectedCommand()];
    if (!command) return;
    if (props.onSlashCommand?.(`/${command.name}`)) {
      editor?.clear();
      setDraft("");
      setSelectedCommand(0);
    }
  };

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
      <Transcript
        sessionId={props.sessionId}
        frames={props.frames}
        sync={props.sync}
        width={props.width}
        model={props.model}
        onStatus={setStatus}
      />
      <Show when={commandMenuVisible()}>
        <CommandPicker
          commands={commands()}
          selected={selectedCommand()}
          onSelect={selectCommand}
          onSelectedChange={setSelectedCommand}
        />
      </Show>
      <textarea
        ref={(value) => (editor = value)}
        placeholder="message the agent"
        focused={props.active()}
        onContentChange={() => {
          setDraft(editor?.plainText ?? "");
          setSelectedCommand(0);
          syncEditorHeight();
        }}
        onKeyDown={(event) => {
          if (!commandMenuVisible()) return;
          if (event.name === "down") {
            setSelectedCommand((value) => Math.min(commands().length - 1, value + 1));
            event.preventDefault();
          } else if (event.name === "up") {
            setSelectedCommand((value) => Math.max(0, value - 1));
            event.preventDefault();
          } else if (event.name === "return" || event.name === "enter") {
            selectCommand();
            event.preventDefault();
          }
        }}
        keyBindings={[
          { name: "return", action: "submit" },
        ]}
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
      <StatusBar model={props.model} working={status() === AgentState.Working} />
    </box>
  );
}

function CommandPicker(props: {
  commands: readonly SlashCommand[];
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
      <For each={props.commands}>
        {(command, index) => (
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
            <text style={{ width: 12, flexShrink: 0, fg: theme.mauve }}>{`/${command.name}`}</text>
            <text style={{ flexGrow: 1, fg: theme.subtext0 }}>{command.description}</text>
          </box>
        )}
      </For>
    </box>
  );
}

function StatusBar(props: { model: string; working: boolean }) {
  return (
    <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
      <text style={{ flexGrow: 1, fg: theme.overlay1 }}>{props.model}</text>
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
