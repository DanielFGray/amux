import type { KeyEvent } from "@opentui/core";

/** Key event types that represent an actual keystroke to forward. Kitty's
 *  protocol also reports releases, which must not be sent to the child or
 *  every keypress arrives twice. */
const FORWARDABLE = new Set(["press", "repeat"]);

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
  if (key.eventType && !FORWARDABLE.has(key.eventType)) return null;

  const raw = key.raw;
  if (raw) return raw;

  const seq = key.sequence;
  if (seq) return key.meta || key.option ? `\x1b${seq}` : seq;

  return null;
}

/** A key the way the keymap's parser describes it: a name plus modifiers. The
 *  compiled parts of parseKeySequence carry one of these as their `stroke`.
 *  send-keys turns these back into bytes via encodeStroke below. */
export interface KeyStroke {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  super?: boolean;
}

/** The child's declared TERM is xterm-256color, so the unmodified named keys
 *  encode as xterm's terminfo sequences — the forms readline and every shell
 *  map natively. */
const NAMED_SEQUENCES: Record<string, string> = {
  return: "\r",
  enter: "\r",
  linefeed: "\n",
  tab: "\t",
  space: " ",
  escape: "\x1b",
  backspace: "\x7f",
  insert: "\x1b[2~",
  delete: "\x1b[3~",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

/** The xterm modified-key forms, parameter and final byte — `\x1b[1;5A` for
 *  ctrl+up. The modifier number is the same 1+shift+2*alt+4*ctrl+8*super
 *  ordering xterm and kitty both use. */
const MODIFIED_CSI: Record<string, [param: string, final: string]> = {
  up: ["1", "A"],
  down: ["1", "B"],
  right: ["1", "C"],
  left: ["1", "D"],
  home: ["1", "H"],
  end: ["1", "F"],
  insert: ["2", "~"],
  delete: ["3", "~"],
  pageup: ["5", "~"],
  pagedown: ["6", "~"],
  f1: ["1", "P"],
  f2: ["1", "Q"],
  f3: ["1", "R"],
  f4: ["1", "S"],
  f5: ["15", "~"],
  f6: ["17", "~"],
  f7: ["18", "~"],
  f8: ["19", "~"],
  f9: ["20", "~"],
  f10: ["21", "~"],
  f11: ["23", "~"],
  f12: ["24", "~"],
};

/** Modified keys with no classic xterm form at all (shift+enter, ctrl+escape)
 *  use the CSI-u codes. The ghostty emulator understands these natively, and
 *  there is no legacy sequence to fall back on. */
const CSI_U: Record<string, number> = {
  backspace: 8,
  tab: 9,
  return: 13,
  enter: 13,
  escape: 27,
  space: 32,
};

/** The named punctuation keys — how a "," or "+" is spelled when whitespace or
 *  the modifier "+" would otherwise split the token that carries it. */
const NAMED_PRINTABLE: Record<string, string> = {
  lt: "<",
  gt: ">",
  plus: "+",
  minus: "-",
  equal: "=",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  backquote: "`",
  leftbracket: "[",
  rightbracket: "]",
};

function csiModifier(stroke: KeyStroke): number {
  return (
    1 +
    (stroke.shift ? 1 : 0) +
    (stroke.meta ? 2 : 0) +
    (stroke.ctrl ? 4 : 0) +
    (stroke.super ? 8 : 0)
  );
}

/** The control code a ctrl-modified printable produces. Everything ASCII that
 *  has one: ^a..^z by the 0x1f mask, and the punctuation that lands in the
 *  control range (^@, ^[, ^\, ^], ^^, ^_, ^? all mask to their control byte).
 *  Anything else — ctrl on a comma, say — has no control form, so it goes
 *  through unmodified rather than inventing a byte. */
function ctrlByte(char: string): string {
  if (/^[a-z@[\]\\^_?]$/.test(char)) return String.fromCharCode(char.charCodeAt(0) & 0x1f);
  return char;
}

function encodeChar(char: string, stroke: KeyStroke): string {
  let out = char;
  if (stroke.ctrl) out = ctrlByte(out);
  // shift is only a modifier on letters; on punctuation it is how the
  // character was produced, and the parser already recorded the result.
  if (stroke.shift && /^[a-z]$/.test(out)) out = out.toUpperCase();
  if (stroke.meta) out = `\x1b${out}`;
  return out;
}

/**
 * Encode a parsed key stroke back into the bytes a terminal child expects.
 *
 * The counterpart to encodeKey for the send-keys path: encodeKey is fed a real
 * keypress, whose `raw` bytes are already the truth; here the key exists only
 * as a parsed name and modifier set, so the sequence has to be synthesized.
 * The unmodified keys use the xterm terminfo of the child's declared TERM; a
 * meta modifier stays the classic ESC prefix (the same rule encodeKey uses for
 * `sequence`, and the one readline's alt+b/alt+f bindings depend on); ctrl and
 * shift on named keys use the modified-CSI forms where they exist and CSI-u
 * where they do not.
 *
 * Returns "" for a name with no encodable sequence (kp1, media keys), which
 * callers treat as "not a key" rather than silently writing nothing.
 */
export function encodeStroke(stroke: KeyStroke): string {
  const { name, ctrl, shift, meta } = stroke;

  // ctrl+space is NUL — the one modified named key with a single-byte form.
  if (name === "space" && ctrl && !shift && !meta) return "\x00";

  const named = NAMED_SEQUENCES[name];
  if (named !== undefined) {
    if (meta) return `\x1b${named}`;
    if (!ctrl && !shift) return named;
    // shift+tab is the one modified key xterm's terminfo spells out directly.
    if (name === "tab" && shift && !ctrl) return "\x1b[Z";
    const csi = MODIFIED_CSI[name];
    if (csi) return `\x1b[${csi[0]};${csiModifier(stroke)}${csi[1]}`;
    const code = CSI_U[name];
    if (code !== undefined) return `\x1b[${code};${csiModifier(stroke)}u`;
    return named;
  }

  // Named printable keys and bare single characters. A multi-codepoint name
  // from the parser's table (kp1, media keys) has no sequence at all.
  const char = NAMED_PRINTABLE[name] ?? name;
  if ([...char].length !== 1) return "";
  return encodeChar(char, stroke);
}
