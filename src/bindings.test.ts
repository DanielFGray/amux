import { test, expect } from "bun:test";
import { Effect } from "effect";
import { createTestRenderer } from "@opentui/core/testing";
import {
  createBindings,
  formatKey,
  helpGroups,
  keyToBinding,
  keysFor,
  leaderBytes,
  filterPaletteEntries,
  paletteEntries,
  type CommandSpec,
} from "./bindings.ts";

/**
 * A binding whose key string the parser rejects is not an error anyone sees —
 * the keymap logs and carries on, and the command is simply dead. So the thing
 * worth asserting is that every sequence we write actually compiled, which is
 * exactly what reading the bindings back out of the keymap tells us.
 */
test("every declared sequence compiles, including multi-char key names", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const commands: CommandSpec[] = [
      { name: "t.letter", key: "<leader>h", desc: "letter", group: "t", run: Effect.void },
      { name: "t.arrow", key: "<leader>left", desc: "arrow", group: "t", run: Effect.void },
      {
        name: "t.brace",
        key: ["<leader>{", "<leader>}"],
        desc: "brace",
        group: "t",
        run: Effect.void,
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });
    const entries = helpGroups(bindings, commands)[0]!.entries;

    expect(entries.map((e) => e.keys)).toEqual(["^a h", "^a left", "^a { / ^a }"]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * Two commands on one sequence is reported, not silently resolved.
 *
 * Only the first-registered of the pair ever fires while both keep reading back
 * as bound. This used to throw, which was right while the table was static;
 * now that the user can rebind anything onto anything it has to be something
 * the settings window can say out loud instead of a crash on startup.
 */
test("a sequence claimed by two commands is reported as a conflict", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const commands: CommandSpec[] = [
      { name: "pane.up", key: "<leader>k", desc: "focus up", group: "t", run: Effect.void },
      { name: "agent.kill", key: "<leader>k", desc: "kill agent", group: "t", run: Effect.void },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });

    expect(bindings.conflicts()).toEqual([
      { sequence: "^a k", commands: ["pane.up", "agent.kill"] },
    ]);
    // Moving one of them off the shared key clears it.
    expect(
      bindings.apply({ leader: "ctrl+a", bindings: { "agent.kill": ["<leader>shift+k"] } }),
    ).toEqual([]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * A capital and its lowercase must be two different bindings.
 *
 * `^a S` (settings) was dead because a bare "S" in a key string compiles to the
 * very same sequence as "s", so `^a s` (new space) claimed both. It has to be
 * written `shift+s`, and read back as "S".
 */
test("shift+letter is a distinct binding from the bare letter", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "t.lower",
        key: "<leader>s",
        desc: "lower",
        group: "t",
        run: Effect.sync(() => fired.push("s")),
      },
      {
        name: "t.upper",
        key: "<leader>shift+s",
        desc: "upper",
        group: "t",
        run: Effect.sync(() => fired.push("S")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("s");
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("S", { shift: true });
    expect(fired).toEqual(["s", "S"]);

    // Written shift+s, shown as the key you actually press.
    expect(helpGroups(bindings, commands)[0]!.entries.map((e) => e.keys)).toEqual(["^a s", "^a S"]);
  } finally {
    t.renderer.destroy();
  }
});

test("pane move uses the encodable shifted-letter binding", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "pane.move",
        key: "<leader>shift+m",
        desc: "move pane",
        group: "panes",
        run: Effect.sync(() => fired.push("move")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("M", { shift: true });
    expect(fired).toEqual(["move"]);
    expect(helpGroups(bindings, commands)[0]!.entries[0]!.keys).toBe("^a M");
  } finally {
    t.renderer.destroy();
  }
});

/**
 * ctrl+arrow is how resize is told apart from focus on the same key, the way
 * tmux ships resize-pane and select-pane under one prefix. The two bindings
 * must compile to different sequences and each fire only its own command.
 * All four directions are checked because a sequence the parser rejects is a
 * binding that reads back fine and dies silently (lrn-42d64b).
 */
test("ctrl+arrow is a distinct binding from the bare arrow", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "pane.focus-left",
        key: "<leader>left",
        desc: "focus pane left",
        group: "panes",
        run: Effect.sync(() => fired.push("focus")),
      },
      {
        name: "pane.resize-left",
        key: "<leader>ctrl+left",
        desc: "resize pane left",
        group: "panes",
        run: Effect.sync(() => fired.push("resize")),
      },
      {
        name: "pane.resize-right",
        key: "<leader>ctrl+right",
        desc: "resize pane right",
        group: "panes",
        run: Effect.sync(() => fired.push("resize-right")),
      },
      {
        name: "pane.resize-up",
        key: "<leader>ctrl+up",
        desc: "resize pane up",
        group: "panes",
        run: Effect.sync(() => fired.push("resize-up")),
      },
      {
        name: "pane.resize-down",
        key: "<leader>ctrl+down",
        desc: "resize pane down",
        group: "panes",
        run: Effect.sync(() => fired.push("resize-down")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressArrow("left", { ctrl: true });
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressArrow("left", {});
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressArrow("right", { ctrl: true });
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressArrow("up", { ctrl: true });
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressArrow("down", { ctrl: true });
    expect(fired).toEqual(["resize", "focus", "resize-right", "resize-up", "resize-down"]);

    expect(helpGroups(bindings, commands)[0]!.entries.map((e) => e.keys)).toEqual([
      "^a left",
      "^a ^left",
      "^a ^right",
      "^a ^up",
      "^a ^down",
    ]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * A command hidden from help must still run.
 *
 * `^a 2`..`^a 9` were dead for exactly this reason: hiding them was done with
 * an empty desc, the keymap rejects empty metadata, and a rejected command
 * still compiles its binding — so every readback showed `^a 2` bound and
 * pressing it did nothing. Only dispatching the key catches that.
 */
test("a command hidden from help still dispatches", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "t.shown",
        key: "<leader>1",
        desc: "select 1..9",
        group: "t",
        run: Effect.sync(() => fired.push("1")),
      },
      {
        name: "t.hidden",
        key: "<leader>2",
        desc: "select 2",
        hidden: true,
        group: "t",
        run: Effect.sync(() => fired.push("2")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("2");
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("1");
    expect(fired).toEqual(["2", "1"]);

    // ...while staying out of the listing it is hidden from.
    expect(helpGroups(bindings, commands)[0]!.entries).toEqual([
      { name: "t.shown", keys: "^a 1", desc: "select 1..9", custom: false, fixed: false },
    ]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * A rebound command answers to the new keys and only the new keys.
 *
 * The keymap compiles bindings once at layer registration, so applying a new
 * set has to tear the layer down and build it again — a patch would leave the
 * old sequence live and give the command two ways in, one of them a surprise.
 */
test("an override replaces a command's default sequences", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "t.zoom",
        key: "<leader>z",
        desc: "zoom",
        group: "t",
        run: Effect.sync(() => fired.push("z")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });
    bindings.apply({ leader: "ctrl+a", bindings: { "t.zoom": ["<leader>f"] } });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("z");
    expect(fired).toEqual([]);

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("f");
    expect(fired).toEqual(["z"]);
    expect(helpGroups(bindings, commands)[0]!.entries[0]!.keys).toBe("^a f");
  } finally {
    t.renderer.destroy();
  }
});

test("palette entries read live bindings and fuzzy-match metadata", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "pane.split-row",
        key: "<leader>|",
        desc: "split left/right",
        group: "panes",
        run: Effect.sync(() => fired.push("split")),
      },
      {
        name: "window.select-layout.tiled",
        desc: "arrange panes",
        hidden: true,
        group: "windows",
        run: Effect.void,
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });
    expect(paletteEntries(bindings, commands)).toEqual([
      { name: "pane.split-row", group: "panes", keys: "^a |", desc: "split left/right" },
      {
        name: "window.select-layout.tiled",
        group: "windows",
        keys: "unbound",
        desc: "arrange panes",
      },
    ]);
    expect(
      filterPaletteEntries(paletteEntries(bindings, commands), "pane.s").map((e) => e.name),
    ).toEqual(["pane.split-row"]);
    expect(bindings.dispatch("pane.split-row")).toBe(true);
    expect(fired).toEqual(["split"]);
  } finally {
    t.renderer.destroy();
  }
});

/** An empty override is how a command is left with no key at all. */
test("an empty override unbinds the command", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "t.quit",
        key: "<leader>q",
        desc: "quit",
        group: "t",
        run: Effect.sync(() => fired.push("q")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });
    bindings.apply({ leader: "ctrl+a", bindings: { "t.quit": [] } });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("q");
    expect(fired).toEqual([]);
    expect(helpGroups(bindings, commands)[0]!.entries[0]!.keys).toBe("unbound");
  } finally {
    t.renderer.destroy();
  }
});

/**
 * Moving the prefix moves every binding with it.
 *
 * That is the whole reason the leader stays a token instead of being written
 * out as `ctrl+a` in each key string: one change, and both dispatch and the
 * printed sequences follow.
 */
test("rebinding the prefix moves every binding and how they read", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "t.new",
        key: "<leader>c",
        desc: "new",
        group: "t",
        run: Effect.sync(() => fired.push("c")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });
    bindings.apply({ leader: "ctrl+b", bindings: {} });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("c");
    expect(fired).toEqual([]);

    t.mockInput.pressKey("b", { ctrl: true });
    t.mockInput.pressKey("c");
    expect(fired).toEqual(["c"]);
    expect(bindings.leader()).toBe("ctrl+b");
    expect(helpGroups(bindings, commands)[0]!.entries[0]!.keys).toBe("^b c");
  } finally {
    t.renderer.destroy();
  }
});

/**
 * Recording a binding has to see keys that are already bound.
 *
 * Pressing the prefix while the editor is waiting must hand back the prefix,
 * not arm a sequence — which is why the capture runs ahead of dispatch rather
 * than off the unhandled-key path.
 */
test("capture takes the next keystroke, bound or not, and skips modifiers", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "t.new",
        key: "<leader>c",
        desc: "new",
        group: "t",
        run: Effect.sync(() => fired.push("c")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });

    const seen: string[] = [];
    bindings.capture((_event, key) => seen.push(key));
    t.mockInput.pressKey("a", { ctrl: true });
    expect(seen).toEqual(["ctrl+a"]);
    // Consumed by the capture, so it never armed the prefix.
    t.mockInput.pressKey("c");
    expect(fired).toEqual([]);

    // And the capture is over after one key.
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("c");
    expect(fired).toEqual(["c"]);
    expect(seen).toEqual(["ctrl+a"]);
  } finally {
    t.renderer.destroy();
  }
});

test("a keystroke reads back as the string that binds it", () => {
  const key = (over: Record<string, unknown>) =>
    keyToBinding({
      name: "x",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "",
      raw: "",
      number: false,
      eventType: "press",
      ...over,
    } as never);

  expect(key({})).toBe("x");
  expect(key({ ctrl: true })).toBe("ctrl+x");
  expect(key({ name: "X", shift: true })).toBe("shift+x");
  expect(key({ name: "left", shift: true })).toBe("shift+left");
  // Shift on punctuation is how the character was produced, not a modifier of it.
  expect(key({ name: "|", shift: true })).toBe("|");
  // Nothing to bind: a bare modifier, or a release.
  expect(key({ name: "shift" })).toBeNull();
  expect(key({ eventType: "release" })).toBeNull();
});

test("the prefix passthrough sends the bytes of whatever prefix is set", () => {
  expect(leaderBytes("ctrl+a")).toBe("\x01");
  expect(leaderBytes("ctrl+b")).toBe("\x02");
  expect(leaderBytes("`")).toBe("`");
});

test("invalid leaders fall back without disabling the keymap", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "t.quit",
        key: "<leader>q",
        desc: "quit",
        group: "t",
        run: Effect.sync(() => fired.push("q")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { leader: "not-a-key", bindings: {} },
      onUnhandled: () => true,
    });

    expect(bindings.leader()).toBe("ctrl+a");
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("q");
    expect(fired).toEqual(["q"]);
  } finally {
    t.renderer.destroy();
  }
});

test("formatting a leader token never recurses", () => {
  expect(formatKey("<leader>", "<leader>")).toBe("<leader>");
});

test("keysFor prefers the override, including an empty one", () => {
  const cmd: CommandSpec = {
    name: "t.a",
    key: ["<leader>a", "<leader>b"],
    desc: "a",
    group: "t",
    run: Effect.void,
  };
  expect(keysFor(cmd, { leader: "ctrl+a", bindings: {} })).toEqual(["<leader>a", "<leader>b"]);
  expect(keysFor(cmd, { leader: "ctrl+a", bindings: { "t.a": ["<leader>z"] } })).toEqual([
    "<leader>z",
  ]);
  expect(keysFor(cmd, { leader: "ctrl+a", bindings: { "t.a": [] } })).toEqual([]);
});

test("agent.new compiles its shifted-letter binding", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "agent.new",
        key: "<leader>shift+n",
        desc: "start a native coding agent",
        group: "agents",
        run: Effect.sync(() => fired.push("agent.new")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("N", { shift: true });
    expect(fired).toEqual(["agent.new"]);
    expect(helpGroups(bindings, commands)[0]!.entries[0]!.keys).toBe("^a N");
  } finally {
    t.renderer.destroy();
  }
});

test("agent.steer compiles its shifted-letter binding", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "agent.steer",
        key: "<leader>shift+e",
        desc: "steer the focused native agent",
        group: "agents",
        run: Effect.sync(() => fired.push("agent.steer")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("E", { shift: true });
    expect(fired).toEqual(["agent.steer"]);
    expect(helpGroups(bindings, commands)[0]!.entries[0]!.keys).toBe("^a E");
  } finally {
    t.renderer.destroy();
  }
});

test("agent.interrupt compiles its shifted-letter binding", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "agent.interrupt",
        key: "<leader>shift+i",
        desc: "interrupt the focused native agent",
        group: "agents",
        run: Effect.sync(() => fired.push("agent.interrupt")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, { onUnhandled: () => true });
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("I", { shift: true });
    expect(fired).toEqual(["agent.interrupt"]);
    expect(helpGroups(bindings, commands)[0]!.entries[0]!.keys).toBe("^a I");
  } finally {
    t.renderer.destroy();
  }
});
