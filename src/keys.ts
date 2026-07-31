import type { KeyEvent } from "@opentui/core"

/** Key event types that represent an actual keystroke to forward. Kitty's
 *  protocol also reports releases, which must not be sent to the child or
 *  every keypress arrives twice. */
const FORWARDABLE = new Set(["press", "repeat"])

/**
 * Turn a parsed key event back into the bytes a terminal child expects.
 *
 * A multiplexer is a pass-through: whatever byte sequence the outer terminal
 * produced is, by definition, what a terminal application wants to receive.
 * `raw` preserves it exactly — including things a parsed representation loses,
 * like the ESC prefix on alt-modified keys. `sequence` is a normalized form and
 * drops those, which silently breaks readline bindings such as alt+b/alt+f.
 */
export function encodeKey(key: KeyEvent): string | null {
  if (key.eventType && !FORWARDABLE.has(key.eventType)) return null

  const raw = key.raw
  if (raw) return raw

  const seq = key.sequence
  if (seq) return key.meta || key.option ? `\x1b${seq}` : seq

  return null
}
