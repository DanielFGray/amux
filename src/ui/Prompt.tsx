/** @jsxImportSource @opentui/solid */
import { For, createSignal, createEffect } from "solid-js"
import { theme } from "./theme.ts"

export interface PromptField {
  label: string
  value?: string
  placeholder?: string
}

export interface PromptRequest {
  title: string
  fields: PromptField[]
  resolve: (values: string[] | null) => void
}

/**
 * Modal multi-field text prompt.
 *
 * The `focused` prop is how a Solid-managed InputRenderable takes focus, and
 * focus is what routes keystrokes into it — the app's key handling only has to
 * refrain from stealing them, not forward them. Feeding the input by hand as
 * well would double every character.
 */
export function Prompt(props: { request: PromptRequest; width: number }) {
  const [field, setField] = createSignal(0)
  const [values, setValues] = createSignal<string[]>([])

  // A new request resets the cursor and seeds the defaults.
  createEffect(() => {
    setValues(props.request.fields.map((f) => f.value ?? ""))
    setField(0)
  })

  const set = (i: number, value: string) =>
    setValues((prev) => prev.map((v, index) => (index === i ? value : v)))

  const submit = () => {
    // Enter on the last field submits; earlier fields advance, so the form is
    // filled top to bottom without reaching for tab.
    if (field() < props.request.fields.length - 1) setField(field() + 1)
    else props.request.resolve(values())
  }

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
    >
      <text style={{ fg: theme.blue, height: 1, flexShrink: 0 }}>{props.request.title}</text>
      <For each={props.request.fields}>
        {(spec, i) => (
          <box style={{ flexDirection: "column", flexShrink: 0 }}>
            <text style={{ fg: theme.subtext0, height: 1, flexShrink: 0 }}>{spec.label}</text>
            <input
              value={values()[i()] ?? ""}
              placeholder={spec.placeholder ?? ""}
              focused={field() === i()}
              style={{
                flexShrink: 0,
                backgroundColor: field() === i() ? theme.surface1 : theme.surface0,
                textColor: theme.text,
                focusedTextColor: theme.text,
              }}
              onInput={(value: string) => set(i(), value)}
              onSubmit={submit}
            />
          </box>
        )}
      </For>
      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
        ↵ next · ⇥ field · esc cancel
      </text>
    </box>
  )
}
