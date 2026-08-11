/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js";
import type { Stream } from "effect";
import type { AttachFrame } from "../effect/AttachProtocol.ts";
import type { PaneViewProps } from "../component-pane.tsx";
import { Transcript } from "./Transcript.tsx";
import { theme } from "./theme.ts";

export interface ChatProps extends PaneViewProps {
  frames: (session: string) => Stream.Stream<AttachFrame, unknown>;
  sync: (session: string) => void;
  /** Send what the user typed to the agent. The command layer's business: a
   *  view does not know whether the session is local or on a daemon. */
  onSubmit: (message: string) => void;
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

  const submit = () => {
    const text = draft().trim();
    setDraft("");
    if (text) props.onSubmit(text);
  };

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
      <Transcript
        session={props.session}
        frames={props.frames}
        sync={props.sync}
        width={props.width()}
      />
      <input
        value={draft()}
        placeholder="message the agent"
        focused={props.active()}
        onInput={setDraft}
        onSubmit={submit}
        style={{
          // An input is one row by construction, so its height is not ours to
          // set — only its refusal to be squeezed out by the transcript.
          flexShrink: 0,
          backgroundColor: props.active() ? theme.surface1 : theme.surface0,
          textColor: theme.text,
          focusedTextColor: theme.text,
        }}
      />
    </box>
  );
}
