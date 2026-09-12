/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { KeyEvent } from "@opentui/core";
import { createBindings, parseKeyStrokes } from "./bindings.ts";
import { encodeStroke } from "./keys.ts";
import {
  tokenizeSendKeys,
  parseSendKeys,
  sendKeys,
  quoteSendKeysLiteral,
  createKeyDispatcher,
  SendKeysError,
  type SendKeyParser,
  type SendTarget,
} from "./send.ts";

/** The keys the app can actually encode, for the encoder-side tests. */
const fakeParse: SendKeyParser = (token: string) => {
  switch (token) {
    case "Enter":
      return [{ name: "enter", ctrl: false, shift: false, meta: false, super: false }];
    case "ctrl+a":
      return [{ name: "a", ctrl: true, shift: false, meta: false, super: false }];
    case "space":
      return [{ name: "space", ctrl: false, shift: false, meta: false, super: false }];
    default:
      return null;
  }
};

function target(events: KeyEvent[] = []): SendTarget & { events: KeyEvent[] } {
  return {
    events,
    key: (event) => {
      events.push(event);
      return true;
    },
    describe: () => "test pane",
  };
}

const encoded = (input: string, parser: SendKeyParser = fakeParse): string =>
  parseSendKeys(input, parser)
    .map((event) => event.raw)
    .join("");

test("tokenizing splits on whitespace and strips quotes", () => {
  expect(tokenizeSendKeys("ls -la Enter")).toEqual([
    { quoted: false, text: "ls" },
    { quoted: false, text: "-la" },
    { quoted: false, text: "Enter" },
  ]);
  expect(tokenizeSendKeys("'ls -la' Enter")).toEqual([
    { quoted: true, text: "ls -la" },
    { quoted: false, text: "Enter" },
  ]);
  expect(tokenizeSendKeys("  'a b'  c  ")).toEqual([
    { quoted: true, text: "a b" },
    { quoted: false, text: "c" },
  ]);
});

test("a quote in the middle of a token is a character, not a delimiter", () => {
  expect(tokenizeSendKeys("it's")).toEqual([{ quoted: false, text: "it's" }]);
});

test("an unterminated quote is an error", () => {
  expect(() => tokenizeSendKeys("'ls -la")).toThrow(SendKeysError);
  expect(() => tokenizeSendKeys("'")).toThrow(SendKeysError);
});

test("consecutive literal tokens join with a single space", () => {
  expect(encoded("hello world")).toBe("hello world");
  expect(encoded("hello   world")).toBe("hello world");
});

test("quoted tokens keep their inner spacing", () => {
  expect(encoded("'ls  -la' Enter")).toBe("ls  -la\r");
});

test("a key token is sent without padding, so 'ls -la Enter' stays ls -la", () => {
  // tmux semantics: a quoted string carries its spaces verbatim, and literal
  // tokens join with a single space — only key tokens are emitted bare.
  expect(encoded("ls -la Enter")).toBe("ls -la\r");
});

test("named keys encode, including the prefix and ctrl", () => {
  expect(encoded("Enter")).toBe("\r");
  expect(encoded("ctrl+a")).toBe("\x01");
  expect(encoded("space")).toBe(" ");
});

test("keys and text mix; a trailing key still lands last", () => {
  expect(encoded("'ls -la' Enter")).toBe("ls -la\r");
  expect(encoded("Enter 'yes'")).toBe("\ryes");
});

test("empty input and an unterminated quote are the two explicit errors", () => {
  expect(() => parseSendKeys("", fakeParse)).toThrow("nothing to send");
  expect(() => parseSendKeys("   ", fakeParse)).toThrow("nothing to send");
  expect(() => parseSendKeys("'", fakeParse)).toThrow("unterminated quote");
});

test("unknown tokens pass through as the text they are", () => {
  // "C-a" reads as three letters, not ctrl+a — quoting makes it text, and so
  // does an all-plain token, which is text either way.
  expect(encoded("'C-a'")).toBe("C-a");
  expect(encoded("C-a")).toBe("C-a");
});

test("quoteSendKeysLiteral prefers single quotes", () => {
  expect(quoteSendKeysLiteral("hello world")).toBe("'hello world'");
});

test("quoteSendKeysLiteral uses double quotes when text has single quotes", () => {
  expect(quoteSendKeysLiteral("it's fine")).toBe(`"it's fine"`);
});

test("quoteSendKeysLiteral refuses text with both quote kinds", () => {
  expect(() => quoteSendKeysLiteral(`it's "fine"`)).toThrow(SendKeysError);
});

test("sendKeys writes to the target and returns null on success", () => {
  const t = target();
  expect(sendKeys(t, "'ls -la' Enter", fakeParse)).toBeNull();
  expect(t.events.map((event) => event.raw).join("")).toBe("ls -la\r");
});

test("sendKeys reports compile errors instead of throwing", () => {
  const t = target();
  const error = sendKeys(t, "''", fakeParse);
  expect(error).toBeInstanceOf(SendKeysError);
  expect(t.events).toEqual([]);
});

test("dispatched keys stop recursive mappings and name the active binding", () => {
  const direct = target();
  let dispatched!: SendTarget;
  const dispatch = createKeyDispatcher(
    (event) => dispatched.key(event),
    () => "loop",
    3,
  );
  dispatched = dispatch(direct);
  const error = sendKeys(dispatched, "x", fakeParse);
  expect(error?.message).toBe("mapping depth exceeded at binding 'loop'");
});

/** The send-keys grammar through the real keymap parser: the same strings that
 *  bind commands name keys in the prompt. */
test("the app's own key strings drive encodeSendKeys end to end", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const bindings = createBindings(t.renderer, [], {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    // createBindings arms the mux prefix token, so <prefix> is meaningful
    // right away — exactly as it is for the command bindings.
    const viaKeymap: SendKeyParser = (token) => parseKeyStrokes(bindings.keymap, token);
    expect(encoded("'ls -la' Enter", viaKeymap)).toBe("ls -la\r");
    expect(encoded("ctrl+a", viaKeymap)).toBe("\x01");
    expect(encoded("<prefix>:", viaKeymap)).toBe("\x01:");
    expect(encoded("<prefix>", viaKeymap)).toBe("\x01");
    // Text that is not a key name passes through unquoted.
    expect(encoded("whoami", viaKeymap)).toBe("whoami");
    // A capital reads as lowercase to the parser, so the original text is
    // what gets sent, not a normalization of it.
    expect(encoded("S", viaKeymap)).toBe("S");
    expect(encoded("Shift+s", viaKeymap)).toBe("S");
  } finally {
    t.renderer.destroy();
  }
});

test("a token holding a key among plain letters encodes the whole sequence", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const bindings = createBindings(t.renderer, [], {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    const viaKeymap: SendKeyParser = (token) => parseKeyStrokes(bindings.keymap, token);
    expect(encoded("<prefix> q", viaKeymap)).toBe("\x01q");
    expect(encoded("'cd /tmp' Enter", viaKeymap)).toBe("cd /tmp\r");
    expect(encoded("cd /tmp Enter", viaKeymap)).toBe("cd /tmp\r");
  } finally {
    t.renderer.destroy();
  }
});

test("modified named keys encode as xterm CSI, not plain chars", () => {
  const key = (
    name: string,
    mods?: Partial<{
      ctrl: boolean;
      shift: boolean;
      meta: boolean;
      super: boolean;
    }>,
  ) => ({
    name,
    ctrl: mods?.ctrl ?? false,
    shift: mods?.shift ?? false,
    meta: mods?.meta ?? false,
    super: mods?.super ?? false,
  });
  expect(encodeStroke(key("space", { ctrl: true }))).toBe("\x00");
  expect(encodeStroke(key("tab", { shift: true }))).toBe("\x1b[Z");
  expect(encodeStroke(key("enter", { shift: true }))).toBe("\x1b[13;2u");
  expect(encodeStroke(key("up", { ctrl: true }))).toBe("\x1b[1;5A");
  expect(encodeStroke(key("a", { ctrl: true }))).toBe("\x01");
  expect(encodeStroke(key("a", { ctrl: true, shift: true }))).toBe("\x01");
});
