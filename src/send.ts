import { encodeStroke, type KeyStroke } from "./keys.ts"

/** A send-keys input that cannot be compiled. The message is what the prompt
 *  shows; the two structural failures are "nothing to send" (empty input) and
 *  "unterminated quote". Anything else is a *value* question, and values are
 *  sent literally rather than reported — an input that does not name a key is
 *  exactly the shell text send-keys exists to type. */
export class SendKeysError extends Error {}

/** Turns one unquoted token into the key strokes that would produce it, or
 *  null when the token is not a key sequence at all. The live keymap's parser
 *  is the source of truth: the same strings that bind a command (`ctrl+a`,
 *  `Enter`, `<leader>`) name a key here, which is why `parseKeyStrokes` backs
 *  this in the app. A token is a single key (`Enter`) or a run containing one
 *  (`<leader>:` is the prefix then a colon); a token of only plain characters
 *  (`hello`, `C-a`) is not a key sequence, it is text. */
export type SendKeyParser = (token: string) => readonly KeyStroke[] | null

/** A pane that can receive injected input. The `write` path is deliberately
 *  the pane's own: bytes go straight to the child's pty, past the app keymap,
 *  so an injected `^a q` can never quit herdr — which is the whole point. */
export interface SendTarget {
  write(bytes: string): void
  /** A human name for the target, for the prompt's title. */
  describe(): string
}

interface RawToken {
  /** Whether the token was wrapped in quotes, which forces literal text. */
  quoted: boolean
  text: string
}

/**
 * Split a send-keys input into tokens, honouring the quoting rules.
 *
 * Whitespace separates tokens. A token that begins with `'` or `"` is a quoted
 * literal: everything up to the matching quote (spaces included) is text, and
 * the quotes are dropped. A quote anywhere else is just a character, so `it's`
 * needs no escaping. A quote that is never closed is an error.
 */
export function tokenizeSendKeys(input: string): RawToken[] {
  const tokens: RawToken[] = []
  let current: RawToken | null = null
  const flush = () => {
    if (current) {
      tokens.push(current)
      current = null
    }
  }

  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    if (ch === "'" || ch === '"') {
      if (current === null) {
        const close = input.indexOf(ch, i + 1)
        if (close === -1) throw new SendKeysError("unterminated quote")
        tokens.push({ quoted: true, text: input.slice(i + 1, close) })
        i = close + 1
      } else {
        current.text += ch
        i++
      }
    } else if (/\s/.test(ch)) {
      flush()
      i++
    } else {
      current ??= { quoted: false, text: "" }
      current.text += ch
      i++
    }
  }
  flush()
  return tokens
}

/**
 * Compile a send-keys input to the bytes a terminal child expects.
 *
 * Tokens are tmux send-keys arguments:
 *
 * - A quoted token (`'ls -la'`) is literal text, spaces and all.
 * - An unquoted token that contains a real key (`Enter`, `ctrl+a`, `space`,
 *   `<leader>`, even `<leader>:`) is encoded as those keys via the app's own
 *   key parser and encoder, so the prefix works too.
 * - Everything else is literal text.
 *
 * Consecutive literal tokens are joined with a single space, so `hello world`
 * stays `hello world`; a key token is sent as-is with no surrounding spaces,
 * so `'ls -la' Enter` and `ls -la Enter` both end in `ls -la\r`. Text that
 * would otherwise read as a key name (`'Enter'`) is quoted. Throws
 * SendKeysError for empty input or an unterminated quote.
 */
export function encodeSendKeys(input: string, parseKey: SendKeyParser): string {
  const tokens = tokenizeSendKeys(input)
  let out = ""
  let lastWasLiteral = false
  let produced = false
  for (const token of tokens) {
    if (token.quoted) {
      if (token.text === "") continue
      if (lastWasLiteral) out += " "
      out += token.text
      lastWasLiteral = true
      produced = true
      continue
    }
    const strokes = parseKey(token.text)
    if (strokes && strokes.some((stroke) => !isPlainStroke(stroke))) {
      const bytes = strokes.map(encodeStroke).join("")
      if (bytes !== "") {
        out += bytes
        lastWasLiteral = false
        produced = true
        continue
      }
    }
    // Not a key send-keys can encode ("C-a" reads as three letters, "kp1" has
    // no terminal sequence): it goes through as the text it is.
    if (lastWasLiteral) out += " "
    out += token.text
    lastWasLiteral = true
    produced = true
  }
  if (!produced) throw new SendKeysError("nothing to send")
  return out
}

/** A stroke whose encoding is just the character it is — a bare printable
 *  with no modifiers. A token made only of these is text: "hello" stays
 *  "hello" (and "S" stays "S", because the parser normalizes capitals to
 *  lowercase), and only a token that actually names a key — named, modified,
 *  or the `<leader>` token — turns into encoded bytes. */
function isPlainStroke(stroke: KeyStroke): boolean {
  return (
    !stroke.ctrl &&
    !stroke.shift &&
    !stroke.meta &&
    !stroke.super &&
    [...stroke.name].length === 1
  )
}

/**
 * Send a compiled input to a target, reporting compile errors instead of
 * throwing — the prompt path wants to show them inline and keep editing.
 * Returns null on success.
 */
export function sendKeys(
  target: SendTarget,
  input: string,
  parseKey: SendKeyParser,
): SendKeysError | null {
  let bytes: string
  try {
    bytes = encodeSendKeys(input, parseKey)
  } catch (error) {
    return error instanceof SendKeysError ? error : new SendKeysError(String(error))
  }
  if (bytes === "") return new SendKeysError("nothing to send")
  target.write(bytes)
  return null
}

/**
 * Pick the pane a send-keys command targets: the focused pane if there is one,
 * else the sidebar's selected agent (revealed first, so it is a place
 * keystrokes land), else nothing — an explicit miss the caller must report.
 * Returning the miss rather than guessing keeps the error honest.
 */
export function pickSendTarget(
  focused: SendTarget | null,
  selected: SendTarget | null,
  reveal: (selected: SendTarget) => void,
): SendTarget | null {
  if (focused) return focused
  if (selected) {
    reveal(selected)
    return selected
  }
  return null
}
