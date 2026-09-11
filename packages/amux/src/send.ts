import { KeyEvent } from "@opentui/core";
import { Keymap, type KeymapHost } from "@opentui/keymap";
import { registerDefaultKeys, registerLeader } from "@opentui/keymap/addons";
import { Match, Schema as S } from "effect";
import { encodeStroke, type KeyStroke } from "./keys.ts";
import { errorMessage } from "./error-message.ts";
import { parseKeyStrokes } from "./bindings.ts";

/** A send-keys input that cannot be compiled. The message is what the prompt
 *  shows; the two structural failures are "nothing to send" (empty input) and
 *  "unterminated quote". Anything else is a *value* question, and values are
 *  sent literally rather than reported — an input that does not name a key is
 *  exactly the shell text send-keys exists to type. */
export class SendKeysError extends S.TaggedError<SendKeysError>()("SendKeysError", {
  message: S.String,
}) {}

/** Turns one unquoted token into the key strokes that would produce it, or
 *  null when the token is not a key sequence at all. The live keymap's parser
 *  is the source of truth: the same strings that bind a command (`ctrl+a`,
 *  `Enter`, `<prefix>`) name a key here, which is why `parseKeyStrokes` backs
 *  this in the app. A token is a single key (`Enter`) or a run containing one
 *  (`<prefix>:` is the prefix then a colon); a token of only plain characters
 *  (`hello`, `C-a`) is not a key sequence, it is text. */
export type SendKeyParser = (token: string) => readonly KeyStroke[] | null;

/**
 * A `SendKeyParser` for a process with no renderer — the daemon, running
 * `pane.send-keys` against a session it owns directly, with no client
 * attached to ask.
 *
 * `@opentui/keymap`'s parser lives on a `Keymap` instance, and a `Keymap`
 * needs a host — but the host contract (docs: "Core keymap") is small and
 * host-agnostic on purpose, precisely so a consumer that only wants parsing
 * can satisfy it without a real target tree. Nothing here ever registers a
 * layer, dispatches a key, or moves focus, so every host method past
 * `isDestroyed: false` is unreachable: parsing never calls back into the
 * host.
 */
export function createHeadlessKeyParser(prefix: string, leader?: string): SendKeyParser {
  const host: KeymapHost<Record<string, never>> = {
    metadata: { platform: "unknown", primaryModifier: "ctrl", modifiers: {} as never },
    rootTarget: {},
    isDestroyed: false,
    getFocusedTarget: () => null,
    getParentTarget: () => null,
    isTargetDestroyed: () => false,
    onKeyPress: () => () => {},
    onKeyRelease: () => () => {},
    onFocusChange: () => () => {},
    onTargetDestroy: () => () => {},
    createCommandEvent: () =>
      new KeyEvent({
        name: "command",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "",
        number: false,
        raw: "",
        eventType: "press",
        source: "raw",
      }),
  };
  const keymap = new Keymap(host);
  registerDefaultKeys(keymap);
  registerLeader(keymap, { name: "prefix", trigger: prefix });
  registerLeader(keymap, { name: "leader", trigger: leader ?? "space" });
  return (token) => parseKeyStrokes(keymap, token);
}

/** A pane that can receive injected input. Direct delivery calls the pane's
 * own key boundary, past the app keymap. */
export interface SendTarget {
  key(event: KeyEvent): boolean;
  /** A human name for the target, for the prompt's title. */
  describe(): string;
}

/** Route a target's injected keys back through binding resolution. The depth
 * belongs to the synthetic dispatch chain, not to a pane or command fiber. */
export function createKeyDispatcher(
  dispatch: (event: KeyEvent) => boolean,
  activeBinding: () => string | null,
  maxDepth = 1000,
): (target: SendTarget) => SendTarget {
  let depth = 0;
  return (target) => ({
    describe: target.describe,
    key(event) {
      if (depth >= maxDepth) {
        throw new SendKeysError({
          message: `mapping depth exceeded at binding '${activeBinding() ?? "unknown"}'`,
        });
      }
      depth += 1;
      try {
        return dispatch(event);
      } finally {
        depth -= 1;
      }
    },
  });
}

interface RawToken {
  /** Whether the token was wrapped in quotes, which forces literal text. */
  quoted: boolean;
  text: string;
}

/** Tokenizer cursor: between tokens, or accumulating an unquoted one. */
type Acc =
  | { readonly _tag: "idle" }
  | { readonly _tag: "token"; readonly text: string };

/**
 * Split a send-keys input into tokens, honouring the quoting rules.
 *
 * Whitespace separates tokens. A token that begins with `'` or `"` is a quoted
 * literal: everything up to the matching quote (spaces included) is text, and
 * the quotes are dropped. A quote anywhere else is just a character, so `it's`
 * needs no escaping. A quote that is never closed is an error.
 */
export function tokenizeSendKeys(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let acc: Acc = { _tag: "idle" };
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    const step: { readonly acc: Acc; readonly next: number } = Match.valueTags(acc, {
      idle: () => {
        if (ch === "'" || ch === '"') {
          const close = input.indexOf(ch, i + 1);
          if (close === -1) throw new SendKeysError({ message: "unterminated quote" });
          tokens.push({ quoted: true, text: input.slice(i + 1, close) });
          return { acc: { _tag: "idle" as const }, next: close + 1 };
        }
        if (/\s/.test(ch)) return { acc: { _tag: "idle" as const }, next: i + 1 };
        return { acc: { _tag: "token" as const, text: ch }, next: i + 1 };
      },
      token: ({ text }) => {
        if (/\s/.test(ch)) {
          tokens.push({ quoted: false, text });
          return { acc: { _tag: "idle" as const }, next: i + 1 };
        }
        return { acc: { _tag: "token" as const, text: text + ch }, next: i + 1 };
      },
    });
    acc = step.acc;
    i = step.next;
  }

  Match.valueTags(acc, {
    idle: () => undefined,
    token: ({ text }) => {
      tokens.push({ quoted: false, text });
    },
  });
  return tokens;
}

/**
 * Compile a send-keys input to the key events a pane receives.
 *
 * Tokens are tmux send-keys arguments:
 *
 * - A quoted token (`'ls -la'`) is literal text, spaces and all.
 * - An unquoted token that contains a real key (`Enter`, `ctrl+a`, `space`,
 *   `<prefix>`, even `<prefix>:`) is encoded as those keys via the app's own
 *   key parser and encoder, so the prefix works too.
 * - Everything else is literal text.
 *
 * Consecutive literal tokens are joined with a single space, so `hello world`
 * stays `hello world`; a key token is sent as-is with no surrounding spaces,
 * so `'ls -la' Enter` and `ls -la Enter` both end in `ls -la\r`. Text that
 * would otherwise read as a key name (`'Enter'`) is quoted. Throws
 * SendKeysError for empty input or an unterminated quote.
 */
export function parseSendKeys(input: string, parseKey: SendKeyParser): KeyEvent[] {
  const tokens = tokenizeSendKeys(input);
  const out: KeyEvent[] = [];
  let lastWasLiteral = false;
  let produced = false;
  for (const token of tokens) {
    if (token.quoted) {
      if (token.text === "") continue;
      if (lastWasLiteral) out.push(...textEvents(" "));
      out.push(...textEvents(token.text));
      lastWasLiteral = true;
      produced = true;
      continue;
    }
    const strokes = parseKey(token.text);
    if (strokes && strokes.some((stroke) => !isPlainStroke(stroke))) {
      const events = strokes.map(strokeEvent).filter((event) => event.raw !== "");
      if (events.length > 0) {
        out.push(...events);
        lastWasLiteral = false;
        produced = true;
        continue;
      }
    }
    // Not a key send-keys can encode ("C-a" reads as three letters, "kp1" has
    // no terminal sequence): it goes through as the text it is.
    if (lastWasLiteral) out.push(...textEvents(" "));
    out.push(...textEvents(token.text));
    lastWasLiteral = true;
    produced = true;
  }
  if (!produced) throw new SendKeysError({ message: "nothing to send" });
  return out;
}

const textEvents = (text: string): KeyEvent[] =>
  [...text].map(
    (char) =>
      new KeyEvent({
        name: char === " " ? "space" : char,
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: char,
        number: false,
        raw: char,
        eventType: "press",
        source: "raw",
      }),
  );

const strokeEvent = (stroke: KeyStroke): KeyEvent => {
  const raw = encodeStroke(stroke);
  return new KeyEvent({
    name: stroke.name,
    ctrl: stroke.ctrl,
    meta: stroke.meta,
    shift: stroke.shift,
    option: stroke.meta,
    super: stroke.super,
    sequence: raw,
    number: false,
    raw,
    eventType: "press",
    source: "raw",
  });
};

/** A stroke whose encoding is just the character it is — a bare printable
 *  with no modifiers. A token made only of these is text: "hello" stays
 *  "hello" (and "S" stays "S", because the parser normalizes capitals to
 *  lowercase), and only a token that actually names a key — named, modified,
 *  or the `<prefix>` token — turns into encoded bytes. */
function isPlainStroke(stroke: KeyStroke): boolean {
  return (
    !stroke.ctrl && !stroke.shift && !stroke.meta && !stroke.super && [...stroke.name].length === 1
  );
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
  try {
    const events = parseSendKeys(input, parseKey);
    for (const event of events) target.key(event);
  } catch (error) {
    return S.is(SendKeysError)(error) ? error : new SendKeysError({ message: errorMessage(error) });
  }
  return null;
}
