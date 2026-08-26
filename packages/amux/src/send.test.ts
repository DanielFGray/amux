import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createBindings, parseKeyStrokes } from "./bindings.ts";
import { encodeStroke } from "./keys.ts";
import {
  tokenizeSendKeys,
  encodeSendKeys,
  sendKeys,
  pickSendTarget,
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

function target(bytes: string[] = []): SendTarget & { bytes: string[] } {
  return {
    bytes,
    write: (b: string) => bytes.push(b),
    describe: () => "test pane",
  };
}

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
  expect(encodeSendKeys("hello world", fakeParse)).toBe("hello world");
  expect(encodeSendKeys("hello   world", fakeParse)).toBe("hello world");
});

test("quoted tokens keep their inner spacing", () => {
  expect(encodeSendKeys("'ls  -la' Enter", fakeParse)).toBe("ls  -la\r");
});

test("a key token is sent without padding, so 'ls -la Enter' stays ls -la", () => {
  // tmux semantics: a quoted string carries its spaces verbatim, and literal
  // tokens join with a single space — only key tokens are emitted bare.
  expect(encodeSendKeys("ls -la Enter", fakeParse)).toBe("ls -la\r");
});

test("named keys encode, including the prefix and ctrl", () => {
  expect(encodeSendKeys("Enter", fakeParse)).toBe("\r");
  expect(encodeSendKeys("ctrl+a", fakeParse)).toBe("\x01");
  expect(encodeSendKeys("space", fakeParse)).toBe(" ");
});

test("keys and text mix; a trailing key still lands last", () => {
  expect(encodeSendKeys("'ls -la' Enter", fakeParse)).toBe("ls -la\r");
  expect(encodeSendKeys("Enter 'yes'", fakeParse)).toBe("\ryes");
});

test("empty input and an unterminated quote are the two explicit errors", () => {
  expect(() => encodeSendKeys("", fakeParse)).toThrow("nothing to send");
  expect(() => encodeSendKeys("   ", fakeParse)).toThrow("nothing to send");
  expect(() => encodeSendKeys("'", fakeParse)).toThrow("unterminated quote");
});

test("unknown tokens pass through as the text they are", () => {
  // "C-a" reads as three letters, not ctrl+a — quoting makes it text, and so
  // does an all-plain token, which is text either way.
  expect(encodeSendKeys("'C-a'", fakeParse)).toBe("C-a");
  expect(encodeSendKeys("C-a", fakeParse)).toBe("C-a");
});

test("sendKeys writes to the target and returns null on success", () => {
  const t = target();
  expect(sendKeys(t, "'ls -la' Enter", fakeParse)).toBeNull();
  expect(t.bytes).toEqual(["ls -la\r"]);
});

test("sendKeys reports compile errors instead of throwing", () => {
  const t = target();
  const error = sendKeys(t, "''", fakeParse);
  expect(error).toBeInstanceOf(SendKeysError);
  expect(t.bytes).toEqual([]);
});

test("pickSendTarget prefers the focused pane", () => {
  const focused = target();
  const selected = target();
  const revealed: string[] = [];
  expect(pickSendTarget(focused, selected, (s) => revealed.push(s.describe()))).toBe(focused);
  expect(revealed).toEqual([]);
});

test("pickSendTarget falls back to the selection and reveals it", () => {
  const selected = target();
  const revealed: string[] = [];
  expect(pickSendTarget(null, selected, (s) => revealed.push(s.describe()))).toBe(selected);
  expect(revealed).toEqual(["test pane"]);
});

test("pickSendTarget reports an explicit miss", () => {
  expect(pickSendTarget(null, null, () => {})).toBeNull();
});

/** The send-keys grammar through the real keymap parser: the same strings that
 *  bind commands name keys in the prompt. */
test("the app's own key strings drive encodeSendKeys end to end", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const bindings = createBindings(t.renderer, [], {
      onUnhandled: () => true,
    });
    // createBindings arms the leader under the default prefix, so <leader> is
    // meaningful right away — exactly as it is for the command bindings.
    const viaKeymap: SendKeyParser = (token) => parseKeyStrokes(bindings.keymap, token);
    expect(encodeSendKeys("'ls -la' Enter", viaKeymap)).toBe("ls -la\r");
    expect(encodeSendKeys("ctrl+a", viaKeymap)).toBe("\x01");
    expect(encodeSendKeys("<leader>:", viaKeymap)).toBe("\x01:");
    expect(encodeSendKeys("<leader>", viaKeymap)).toBe("\x01");
    // Text that is not a key name passes through unquoted.
    expect(encodeSendKeys("whoami", viaKeymap)).toBe("whoami");
    // A capital reads as lowercase to the parser, so the original text is
    // what gets sent, not a normalization of it.
    expect(encodeSendKeys("S", viaKeymap)).toBe("S");
    expect(encodeSendKeys("Shift+s", viaKeymap)).toBe("S");
  } finally {
    t.renderer.destroy();
  }
});

test("a token holding a key among plain letters encodes the whole sequence", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const bindings = createBindings(t.renderer, [], {
      onUnhandled: () => true,
    });
    const viaKeymap: SendKeyParser = (token) => parseKeyStrokes(bindings.keymap, token);
    expect(encodeSendKeys("<leader> q", viaKeymap)).toBe("\x01q");
    expect(encodeSendKeys("'cd /tmp' Enter", viaKeymap)).toBe("cd /tmp\r");
    expect(encodeSendKeys("cd /tmp Enter", viaKeymap)).toBe("cd /tmp\r");
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
