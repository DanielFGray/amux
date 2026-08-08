/** @jsxImportSource @opentui/solid */
import { For, Show, createSignal, createEffect } from "solid-js";
import type { InputRenderable } from "@opentui/core";
import { theme } from "./theme.ts";

export interface PromptField {
  label: string;
  value?: string;
  placeholder?: string;
  masked?: boolean;
}

export interface PromptRequest {
  title: string;
  fields: PromptField[];
  footer?: string;
  notice?: string;
  resolve: (values: string[] | null) => void;
}

const isPrintable = (s: string): boolean =>
  s.length === 1 && s.charCodeAt(0) >= 32 && s.charCodeAt(0) !== 127;

/**
 * Modal multi-field text prompt.
 *
 * Masked fields use a custom input path: all editing is intercepted in
 * onKeyDown with preventDefault so plaintext never enters the renderable's
 * edit buffer. The renderable displays only stars, updated directly via the
 * captured ref. The real secret lives only in the `values` signal.
 */
export function Prompt(props: {
  request: PromptRequest;
  width: number;
  error?: string;
}) {
  const [field, setField] = createSignal(0);
  const [values, setValues] = createSignal<string[]>([]);

  createEffect(() => {
    setValues(props.request.fields.map((f) => f.value ?? ""));
    setField(0);
  });

  const set = (i: number, value: string) =>
    setValues((prev) => prev.map((v, index) => (index === i ? value : v)));

  const submit = () => {
    if (field() < props.request.fields.length - 1) setField(field() + 1);
    else props.request.resolve(values());
  };

  const nextField = () => {
    if (field() < props.request.fields.length - 1) setField(field() + 1);
    else setField(0);
  };

  const maskedInputs: Map<number, InputRenderable> = new Map();

  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - 60) / 2)),
        top: 2,
        width: 60,
        flexDirection: "column",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.blue,
        padding: 1,
        zIndex: 300,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <text style={{ fg: theme.blue, height: 1, flexShrink: 0 }}>{props.request.title}</text>
      <Show
        when={props.request.notice}
        fallback={
          <>
            <For each={props.request.fields}>
              {(spec, i) => {
                const idx = i();
                const syncMask = () => {
                  const input = maskedInputs.get(idx);
                  if (input) input.value = "*".repeat((values()[idx] ?? "").length);
                };

                return (
                  <box style={{ flexDirection: "column", flexShrink: 0 }}>
                    <text style={{ fg: theme.subtext0, height: 1, flexShrink: 0 }}>{spec.label}</text>
                    <box style={{ position: "relative", height: 1, flexShrink: 0 }}>
                      <input
                        value={spec.masked ? "" : (values()[idx] ?? "")}
                        placeholder={spec.placeholder ?? ""}
                        focused={field() === idx}
                        ref={spec.masked ? (el: InputRenderable) => { maskedInputs.set(idx, el); } : undefined}
                        onKeyDown={(key) => {
                          if (field() !== idx) return;
                          if (key.name === "tab") {
                            nextField();
                            key.preventDefault();
                            return;
                          }
                          if (spec.masked) {
                            if (key.name === "return" || key.name === "kpenter" || key.name === "linefeed") {
                              submit();
                              key.preventDefault();
                              return;
                            }
                            if (key.name === "backspace") {
                              const cur = values()[idx] ?? "";
                              if (cur.length > 0) {
                                set(idx, cur.slice(0, -1));
                                syncMask();
                              }
                              key.preventDefault();
                              return;
                            }
                            if (isPrintable(key.sequence)) {
                              set(idx, (values()[idx] ?? "") + key.sequence);
                              syncMask();
                              key.preventDefault();
                              return;
                            }
                            key.preventDefault();
                          }
                        }}
                        onPaste={
                          spec.masked
                            ? (event) => {
                                const text = new TextDecoder().decode(event.bytes).replace(/[\n\r]/g, "");
                                if (text) {
                                  set(idx, (values()[idx] ?? "") + text);
                                  syncMask();
                                }
                                event.preventDefault();
                              }
                            : undefined
                        }
                        style={{
                          flexShrink: 0,
                          backgroundColor: field() === idx ? theme.surface1 : theme.surface0,
                          textColor: theme.text,
                          focusedTextColor: theme.text,
                        }}
                        onInput={spec.masked ? undefined : (value: string) => set(idx, value)}
                        onSubmit={submit}
                      />
                    </box>
                  </box>
                );
              }}
            </For>
            <Show when={props.error}>
              <text style={{ fg: theme.red, height: 1, flexShrink: 0 }}>{props.error}</text>
            </Show>
            <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
              {props.request.footer ?? "↵ next · ⇥ field · esc cancel"}
            </text>
          </>
        }
      >
        <text style={{ fg: theme.text, height: 1, flexShrink: 0 }}>{props.request.notice}</text>
        <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
          ↵ dismiss · esc dismiss
        </text>
      </Show>
    </box>
  );
}
