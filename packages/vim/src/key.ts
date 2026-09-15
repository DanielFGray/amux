/**
 * Key Schema: Type is the press shape the engine reads; Encoded is vim notation
 * (`j`, `<C-w>`, `<Esc>`, `<CR>`). Change/macro tapes and cascades hold Key
 * values. Encoded appears only at text boundaries (register text, :normal
 * args, map stroke tables); decode there fails on bad input.
 */
import { Effect, Option, Schema as S, SchemaGetter, SchemaIssue } from "effect";

export const KeyStruct = S.Struct({
  name: S.String,
  sequence: S.String,
  shift: S.Boolean,
  ctrl: S.Boolean,
  meta: S.Boolean,
  option: S.Boolean,
});
export type Key = typeof KeyStruct.Type;

const baseKey = (partial: {
  name: string;
  sequence: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
}): Key => ({
  name: partial.name,
  sequence: partial.sequence,
  shift: partial.shift ?? false,
  ctrl: partial.ctrl ?? false,
  meta: partial.meta ?? false,
  option: partial.option ?? false,
});

/**
 * Build a Key for a press. `token` is a printable character or a Key.name
 * (`escape`, `return`, `delete`, `pagedown`, …).
 */
export const press = (
  token: string,
  mods: Partial<Pick<Key, "ctrl" | "meta" | "option" | "shift" | "sequence">> = {},
): Key => {
  if (token === "escape") {
    return baseKey({ name: "escape", sequence: mods.sequence ?? "\x1b", ...mods });
  }
  if (token === "return" || token === "enter") {
    return baseKey({ name: "return", sequence: mods.sequence ?? "\r", ...mods });
  }
  if (token === "backspace") {
    return baseKey({ name: "backspace", sequence: mods.sequence ?? "\b", ...mods });
  }
  if (token === "tab") {
    return baseKey({ name: "tab", sequence: mods.sequence ?? "\t", ...mods });
  }
  if (token === "space") {
    return baseKey({ name: "space", sequence: mods.sequence ?? " ", ...mods });
  }
  if (
    token === "delete" ||
    token === "up" ||
    token === "down" ||
    token === "left" ||
    token === "right" ||
    token === "pageup" ||
    token === "pagedown" ||
    token === "home" ||
    token === "end"
  ) {
    return baseKey({ name: token, sequence: mods.sequence ?? "", ...mods });
  }
  if ([...token].length === 1) {
    const ch = token;
    const shift =
      mods.shift ?? (ch !== ch.toLowerCase() && ch === ch.toUpperCase() && /[A-Za-z]/.test(ch));
    return baseKey({
      name: shift && /[A-Za-z]/.test(ch) ? ch.toLowerCase() : ch,
      sequence: mods.sequence ?? ch,
      shift,
      ctrl: mods.ctrl,
      meta: mods.meta,
      option: mods.option,
    });
  }
  return baseKey({ name: token, sequence: mods.sequence ?? token, ...mods });
};

const encodeSpecial = (name: string): string | undefined => {
  switch (name) {
    case "escape":
      return "<Esc>";
    case "return":
    case "enter":
      return "<CR>";
    case "backspace":
      return "<BS>";
    case "tab":
      return "<Tab>";
    case "space":
      return "<Space>";
    case "delete":
      return "<Del>";
    case "up":
      return "<Up>";
    case "down":
      return "<Down>";
    case "left":
      return "<Left>";
    case "right":
      return "<Right>";
    case "pageup":
      return "<PageUp>";
    case "pagedown":
      return "<PageDown>";
    case "home":
      return "<Home>";
    case "end":
      return "<End>";
    default:
      return undefined;
  }
};

/**
 * Encode a Key to vim notation. Returns null for chords the engine does not
 * put on a text boundary (meta/option, empty ctrl name).
 */
export const encodeKey = (key: Key): string | null => {
  if (key.meta || key.option) return null;
  if (key.ctrl) {
    if (!key.name || key.name.length === 0) return null;
    const letter = key.name.length === 1 ? key.name.toLowerCase() : key.name;
    return `<C-${letter}>`;
  }
  const special = encodeSpecial(key.name);
  if (special !== undefined) return special;
  const char =
    key.sequence && [...key.sequence].length === 1
      ? key.sequence
      : key.name && key.name.length === 1
        ? key.shift && /[a-z]/.test(key.name)
          ? key.name.toUpperCase()
          : key.name
        : null;
  if (char === null) return null;
  if (char === "<") return "<lt>";
  return char;
};

const decodeSpecialBody = (name: string): { name: string; sequence: string } | undefined => {
  switch (name) {
    case "esc":
      return { name: "escape", sequence: "\x1b" };
    case "cr":
    case "enter":
    case "return":
      return { name: "return", sequence: "\r" };
    case "bs":
      return { name: "backspace", sequence: "\b" };
    case "tab":
      return { name: "tab", sequence: "\t" };
    case "space":
      return { name: "space", sequence: " " };
    case "del":
      return { name: "delete", sequence: "" };
    case "up":
      return { name: "up", sequence: "" };
    case "down":
      return { name: "down", sequence: "" };
    case "left":
      return { name: "left", sequence: "" };
    case "right":
      return { name: "right", sequence: "" };
    case "pageup":
      return { name: "pageup", sequence: "" };
    case "pagedown":
      return { name: "pagedown", sequence: "" };
    case "home":
      return { name: "home", sequence: "" };
    case "end":
      return { name: "end", sequence: "" };
    default:
      return undefined;
  }
};

const parseAngle = (body: string): Option.Option<Key> => {
  const lower = body.toLowerCase();
  let ctrl = false;
  let meta = false;
  let option = false;
  let shift = false;
  let rest = lower;
  for (;;) {
    if (rest.startsWith("c-")) {
      ctrl = true;
      rest = rest.slice(2);
      continue;
    }
    if (rest.startsWith("m-")) {
      meta = true;
      rest = rest.slice(2);
      continue;
    }
    if (rest.startsWith("a-")) {
      option = true;
      rest = rest.slice(2);
      continue;
    }
    if (rest.startsWith("s-")) {
      shift = true;
      rest = rest.slice(2);
      continue;
    }
    break;
  }
  if (rest === "lt") {
    return Option.some(baseKey({ name: "<", sequence: "<", shift, ctrl, meta, option }));
  }
  const special = decodeSpecialBody(rest);
  if (special !== undefined) {
    return Option.some(baseKey({ ...special, shift, ctrl, meta, option }));
  }
  if (rest.length === 1) {
    const last = body.length === 0 ? undefined : body[body.length - 1];
    const isUpper = last !== undefined && /[A-Z]/.test(last);
    const letter = rest;
    return Option.some(
      baseKey({
        name: letter,
        sequence: isUpper || shift ? letter.toUpperCase() : letter,
        shift: shift || isUpper,
        ctrl,
        meta,
        option,
      }),
    );
  }
  return Option.none();
};

/**
 * Decode vim notation only. Accepts `<Esc>`, `<CR>`/`<Enter>`/`<Return>`,
 * `<BS>`, `<Tab>`, `<Space>`, `<Del>`, `<lt>`, arrows, page/home/end,
 * `<C-`/`<M-`/`<A-`/`<S-` modifiers, and single characters. Nothing else.
 */
export const decodeKey = (encoded: string): Option.Option<Key> => {
  if (encoded.length === 0) return Option.none();
  if (encoded.startsWith("<") && encoded.endsWith(">") && encoded.length >= 3) {
    return parseAngle(encoded.slice(1, -1));
  }
  if (encoded === " ") {
    return Option.some(baseKey({ name: "space", sequence: " " }));
  }
  if ([...encoded].length === 1) {
    const ch = encoded;
    const shift = ch !== ch.toLowerCase() && ch === ch.toUpperCase() && /[A-Za-z]/.test(ch);
    return Option.some(
      baseKey({
        name: shift ? ch.toLowerCase() : ch,
        sequence: ch,
        shift,
      }),
    );
  }
  return Option.none();
};

/** Key Schema: Encoded is vim notation; Type is the Key struct. */
export const KeySchema = S.String.pipe(
  S.decodeTo(KeyStruct, {
    decode: SchemaGetter.transformOrFail((encoded: string) => {
      const key = decodeKey(encoded);
      if (Option.isNone(key)) {
        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: `invalid vim key notation: ${encoded}` }),
        );
      }
      return Effect.succeed(key.value);
    }),
    encode: SchemaGetter.transformOrFail((key: Key) => {
      const encoded = encodeKey(key);
      if (encoded === null) {
        return Effect.fail(new SchemaIssue.InvalidValue({ message: "key is not encodable" }));
      }
      return Effect.succeed(encoded);
    }),
  }),
);
