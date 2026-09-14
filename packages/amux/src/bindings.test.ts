/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { test, expect } from "bun:test";
import { Context, Duration, Effect, Option } from "effect";
import { NO_REALM, Realm, realmOf } from "./realm.ts";
import { createSignal } from "solid-js";
import { createTestRenderer } from "@opentui/core/testing";
import type { KeyEvent } from "@opentui/core";
import {
  contextCommand,
  createBindings,
  createPendingTable,
  formatKey,
  helpGroups,
  keyToBinding,
  keysFor,
  filterPaletteEntries,
  mayDispatchPaletteEntry,
  nextKeys,
  paletteEntries,
  pendingStrokes,
  registerLayerChecked,
  type CommandSpec,
} from "./bindings.ts";
import { makeCommands } from "./commands.ts";
import { CONTEXT_PRIORITY, type ContextSpec } from "./key-context.ts";
import {
  createCountAccumulator,
  KeyInvocation,
  type KeyInvocationValue,
} from "./key-invocation.ts";

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
      {
        name: "t.letter",
        key: "<prefix>h",
        desc: "letter",
        group: "t",
        run: Effect.void,
      },
      {
        name: "t.arrow",
        key: "<prefix>left",
        desc: "arrow",
        group: "t",
        run: Effect.void,
      },
      {
        name: "t.brace",
        key: ["<prefix>{", "<prefix>}"],
        desc: "brace",
        group: "t",
        run: Effect.void,
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    const entries = helpGroups(bindings, commands)[0]!.entries;

    expect(entries.map((e) => e.keys)).toEqual(["^a h", "^a left", "^a { / ^a }"]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * The keymap's own CommandContext (event/data/input/payload) used to be
 * thrown away at dispatch — `apply()` registered every command as a nullary
 * `run: () => runDetached(...)`. A command that declares `KeyInvocation` in
 * its requirement now receives it for real, read off the live keystroke that
 * fired it, and a command that declares nothing (most of them) is dispatched
 * exactly as before.
 */
test("a command that declares KeyInvocation receives the keystroke that ran it", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    let seen: KeyInvocationValue | undefined;
    const commands: CommandSpec[] = [
      {
        name: "t.echo",
        key: "<prefix>e",
        desc: "echo",
        group: "t",
        run: Effect.gen(function* () {
          seen = yield* KeyInvocation;
        }),
      },
    ];
    createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("e");

    expect(seen?.event.name).toBe("e");
    expect(seen?.data).toEqual({});
  } finally {
    t.renderer.destroy();
  }
});

test("a context pre-dispatch hook consumes count digits and publishes them to its command", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const count = createCountAccumulator();
    let seen: KeyInvocationValue | undefined;
    const normal: ContextSpec = {
      ...testContext("editor.normal", CONTEXT_PRIORITY.PANE, () => true),
      beforeDispatch: (input) => {
        if (count.offer(input.event, (name) => name === "0")) {
          input.consume({ preventDefault: true });
          return;
        }
        if (count.digits() !== "") input.setData("count", count.count());
      },
    };
    createBindings(
      t.renderer,
      [
        contextCommand(normal, {
          name: "delete",
          key: "d",
          desc: "delete",
          group: "editor",
          run: Effect.gen(function* () {
            seen = yield* KeyInvocation;
          }),
        }),
      ],
      { onUnhandled: () => true },
    );

    t.mockInput.pressKey("2");
    t.mockInput.pressKey("d");

    expect(seen?.data).toEqual({ count: 2 });
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
      {
        name: "pane.up",
        key: "<prefix>k",
        desc: "focus up",
        group: "t",
        run: Effect.void,
      },
      {
        name: "agent.kill",
        key: "<prefix>k",
        desc: "kill agent",
        group: "t",
        run: Effect.void,
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

    expect(bindings.conflicts()).toEqual([
      { sequence: "^a k", commands: ["pane.up", "agent.kill"] },
    ]);
    // Moving one of them off the shared key clears it.
    expect(
      bindings.apply({
        prefix: "ctrl+a",
        leader: "space",
        bindings: { "agent.kill": ["<prefix>shift+k"] },
      }),
    ).toEqual([]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * Pane focus owns hjkl. window.last used to sit on `<prefix>l` alone while
 * focus-right had no letter — not a `findConflicts` hit (only one claimer),
 * just a dead-looking key. Binding both to `l` must report; defaults keep
 * last-window on `<prefix>shift+l` (bare "L" compiles as lowercase — see
 * app.settings's shift+s) so the detector can catch a regression.
 */
test("pane focus hjkl and window.last on shift+l do not conflict; sharing l does", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const focus = (direction: string, letter: string): CommandSpec => ({
      name: `pane.focus-${direction}`,
      key: [`<prefix>${letter}`, `<prefix>${direction}`],
      desc: `focus ${direction}`,
      group: "t",
      run: Effect.sync(() => fired.push(direction)),
    });
    const commands: CommandSpec[] = [
      focus("left", "h"),
      focus("down", "j"),
      focus("up", "k"),
      focus("right", "l"),
      {
        name: "window.last",
        key: "<prefix>shift+l",
        desc: "last window",
        group: "t",
        run: Effect.sync(() => fired.push("window.last")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    expect(bindings.conflicts()).toEqual([]);

    t.mockInput.pressKey("s", { ctrl: true });
    t.mockInput.pressKey("l");
    expect(fired).toEqual(["right"]);

    expect(
      bindings.apply({
        prefix: "ctrl+s",
        leader: "space",
        bindings: { "window.last": ["<prefix>l"] },
      }),
    ).toEqual([{ sequence: "^s l", commands: ["pane.focus-right", "window.last"] }]);
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
        key: "<prefix>s",
        desc: "lower",
        group: "t",
        run: Effect.sync(() => fired.push("s")),
      },
      {
        name: "t.upper",
        key: "<prefix>shift+s",
        desc: "upper",
        group: "t",
        run: Effect.sync(() => fired.push("S")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

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
        key: "<prefix>shift+m",
        desc: "move pane",
        group: "panes",
        run: Effect.sync(() => fired.push("move")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
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
        key: "<prefix>left",
        desc: "focus pane left",
        group: "panes",
        run: Effect.sync(() => fired.push("focus")),
      },
      {
        name: "pane.resize-left",
        key: "<prefix>ctrl+left",
        desc: "resize pane left",
        group: "panes",
        run: Effect.sync(() => fired.push("resize")),
      },
      {
        name: "pane.resize-right",
        key: "<prefix>ctrl+right",
        desc: "resize pane right",
        group: "panes",
        run: Effect.sync(() => fired.push("resize-right")),
      },
      {
        name: "pane.resize-up",
        key: "<prefix>ctrl+up",
        desc: "resize pane up",
        group: "panes",
        run: Effect.sync(() => fired.push("resize-up")),
      },
      {
        name: "pane.resize-down",
        key: "<prefix>ctrl+down",
        desc: "resize pane down",
        group: "panes",
        run: Effect.sync(() => fired.push("resize-down")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

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
        key: "<prefix>1",
        desc: "select 1..9",
        group: "t",
        run: Effect.sync(() => fired.push("1")),
      },
      {
        name: "t.hidden",
        key: "<prefix>2",
        desc: "select 2",
        hidden: true,
        group: "t",
        run: Effect.sync(() => fired.push("2")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("2");
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("1");
    expect(fired).toEqual(["2", "1"]);

    // ...while staying out of the listing it is hidden from.
    expect(helpGroups(bindings, commands)[0]!.entries).toEqual([
      {
        name: "t.shown",
        keys: "^a 1",
        desc: "select 1..9",
        custom: false,
        fixed: false,
        orphaned: false,
        context: "",
      },
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
        key: "<prefix>z",
        desc: "zoom",
        group: "t",
        run: Effect.sync(() => fired.push("z")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    bindings.apply({ prefix: "ctrl+a", leader: "space", bindings: { "t.zoom": ["<prefix>f"] } });

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
        key: "<prefix>|",
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
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    expect(paletteEntries(bindings, commands)).toEqual([
      {
        name: "pane.split-row",
        group: "panes",
        keys: "^a |",
        desc: "split left/right",
        available: true,
        contextual: false,
        hidden: false,
      },
      {
        name: "window.select-layout.tiled",
        group: "windows",
        keys: "unbound",
        desc: "arrange panes",
        available: true,
        contextual: false,
        hidden: false,
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

test("palette ranks available contextual commands above globals", () => {
  const entries = [
    {
      name: "pane.split",
      group: "panes",
      keys: "^a |",
      desc: "split",
      available: true,
      contextual: false,
      hidden: false,
    },
    {
      name: "editor.surround",
      group: "editor",
      keys: "unbound",
      desc: "surround selection",
      available: true,
      contextual: true,
      hidden: false,
    },
    {
      name: "copy.yank",
      group: "copy",
      keys: "y",
      desc: "yank",
      available: false,
      contextual: false,
      hidden: false,
    },
  ];
  expect(filterPaletteEntries(entries, "").map((e) => e.name)).toEqual([
    "editor.surround",
    "pane.split",
    "copy.yank",
  ]);
});

test("palette query score applies within available/contextual bands", () => {
  const entries = [
    {
      name: "zzz.global",
      group: "global",
      keys: "unbound",
      desc: "split panes globally",
      available: true,
      contextual: false,
      hidden: false,
    },
    {
      name: "editor.split-selection",
      group: "editor",
      keys: "unbound",
      desc: "other",
      available: true,
      contextual: true,
      hidden: false,
    },
    {
      name: "pane.split-row",
      group: "panes",
      keys: "^a |",
      desc: "split left/right",
      available: true,
      contextual: false,
      hidden: false,
    },
  ];
  // Contextual still wins over a tighter global subsequence match.
  expect(filterPaletteEntries(entries, "split").map((e) => e.name)).toEqual([
    "editor.split-selection",
    "pane.split-row",
    "zzz.global",
  ]);
});

test("paletteEntries stamps contextual from a live non-global context", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    let editorActive = true;
    const editorCtx: ContextSpec = {
      id: "editor.focused",
      active: () => editorActive,
      priority: CONTEXT_PRIORITY.PANE,
      rebindable: false,
    };
    const commands: CommandSpec[] = [
      {
        name: "pane.split-row",
        key: "<prefix>|",
        desc: "split",
        group: "panes",
        run: Effect.void,
      },
      contextCommand(editorCtx, {
        name: "surround",
        key: "",
        desc: "surround",
        group: "editor",
        run: Effect.void,
      }),
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    expect(
      paletteEntries(bindings, commands).map((e) => [e.name, e.available, e.contextual, e.hidden]),
    ).toEqual([
      ["pane.split-row", true, false, false],
      ["editor.focused.surround", true, true, false],
    ]);
    expect(filterPaletteEntries(paletteEntries(bindings, commands), "").map((e) => e.name)).toEqual(
      ["editor.focused.surround", "pane.split-row"],
    );

    editorActive = false;
    expect(
      paletteEntries(bindings, commands).map((e) => [e.name, e.available, e.contextual, e.hidden]),
    ).toEqual([
      ["pane.split-row", true, false, false],
      ["editor.focused.surround", false, false, true],
    ]);
    // Runnable palette hides inactive PANE-band verbs.
    expect(filterPaletteEntries(paletteEntries(bindings, commands), "").map((e) => e.name)).toEqual(
      ["pane.split-row"],
    );
    // Keybind picker keeps them for remap.
    expect(
      filterPaletteEntries(paletteEntries(bindings, commands), "", { includeHidden: true }).map(
        (e) => e.name,
      ),
    ).toEqual(["pane.split-row", "editor.focused.surround"]);
  } finally {
    t.renderer.destroy();
  }
});

test("palette dims inactive APP_MODE verbs but does not hide them", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    let copyActive = false;
    const copyMode: ContextSpec = {
      id: "copy-mode",
      active: () => copyActive,
      priority: CONTEXT_PRIORITY.APP_MODE,
      rebindable: false,
    };
    const commands: CommandSpec[] = [
      {
        name: "pane.split-row",
        key: "<prefix>|",
        desc: "split",
        group: "panes",
        run: Effect.void,
      },
      contextCommand(copyMode, {
        name: "yank",
        key: "y",
        desc: "yank selection",
        group: "copy",
        run: Effect.void,
      }),
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    const inactive = paletteEntries(bindings, commands);
    expect(inactive.map((e) => [e.name, e.available, e.hidden])).toEqual([
      ["pane.split-row", true, false],
      ["copy-mode.yank", false, false],
    ]);
    expect(filterPaletteEntries(inactive, "").map((e) => e.name)).toEqual([
      "pane.split-row",
      "copy-mode.yank",
    ]);
    expect(mayDispatchPaletteEntry(inactive[1]!)).toBe(false);

    copyActive = true;
    const active = paletteEntries(bindings, commands);
    expect(active.map((e) => [e.name, e.available, e.contextual, e.hidden])).toEqual([
      ["pane.split-row", true, false, false],
      ["copy-mode.yank", true, true, false],
    ]);
    expect(mayDispatchPaletteEntry(active[1]!)).toBe(true);
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
        key: "<prefix>q",
        desc: "quit",
        group: "t",
        run: Effect.sync(() => fired.push("q")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    bindings.apply({ prefix: "ctrl+a", leader: "space", bindings: { "t.quit": [] } });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("q");
    expect(fired).toEqual([]);
    expect(helpGroups(bindings, commands)[0]!.entries[0]!.keys).toBe("unbound");
  } finally {
    t.renderer.destroy();
  }
});

test("a binding for a command nothing registers is surfaced as orphaned, not dropped", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const commands: CommandSpec[] = [
      { name: "t.quit", key: "<prefix>q", desc: "quit", group: "t", run: Effect.void },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    const keys = {
      prefix: "ctrl+a",
      leader: "space",
      bindings: { "t.quit": ["<prefix>q"], "plugin.disabled-verb": ["<prefix>z"] },
    };
    bindings.apply(keys);

    const groups = helpGroups(bindings, commands, keys);
    expect(groups.map((g) => g.group)).toEqual(["t", "orphaned"]);
    expect(groups.find((g) => g.group === "orphaned")!.entries).toEqual([
      {
        name: "plugin.disabled-verb",
        keys: "^a z",
        desc: "unknown command",
        custom: true,
        fixed: false,
        orphaned: true,
        context: "",
      },
    ]);
  } finally {
    t.renderer.destroy();
  }
});

test("an unbound orphaned entry reads back as unbound, same as any other command", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const commands: CommandSpec[] = [];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    const keys = { prefix: "ctrl+a", leader: "space", bindings: { "plugin.disabled-verb": [] } };
    bindings.apply(keys);

    expect(helpGroups(bindings, commands, keys)[0]!.entries[0]!.keys).toBe("unbound");
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
        key: "<prefix>c",
        desc: "new",
        group: "t",
        run: Effect.sync(() => fired.push("c")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    bindings.apply({ prefix: "ctrl+b", leader: "space", bindings: {} });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("c");
    expect(fired).toEqual([]);

    t.mockInput.pressKey("b", { ctrl: true });
    t.mockInput.pressKey("c");
    expect(fired).toEqual(["c"]);
    expect(bindings.prefix()).toBe("ctrl+b");
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
        key: "<prefix>c",
        desc: "new",
        group: "t",
        run: Effect.sync(() => fired.push("c")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

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
  const key = (over: Partial<KeyEvent>) =>
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
    } as KeyEvent);

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

test("invalid leaders fall back without disabling the keymap", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "t.quit",
        key: "<prefix>q",
        desc: "quit",
        group: "t",
        run: Effect.sync(() => fired.push("q")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "not-a-key", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

    expect(bindings.prefix()).toBe("ctrl+s");
    t.mockInput.pressKey("s", { ctrl: true });
    t.mockInput.pressKey("q");
    expect(fired).toEqual(["q"]);
  } finally {
    t.renderer.destroy();
  }
});

test("formatting a leader token never recurses", () => {
  expect(formatKey("<prefix>", "<prefix>")).toBe("<prefix>");
  expect(formatKey("<leader>", { leader: "<leader>" })).toBe("<leader>");
});

test("formatKey expands leader independently of mux prefix", () => {
  expect(formatKey("<leader>", { prefix: "ctrl+s", leader: "space" })).toBe("SPC");
  expect(formatKey("<prefix>", { prefix: "ctrl+s", leader: "space" })).toBe("^s");
});

test("keysFor prefers the override, including an empty one", () => {
  const cmd: CommandSpec = {
    name: "t.a",
    key: ["<prefix>a", "<prefix>b"],
    desc: "a",
    group: "t",
    run: Effect.void,
  };
  expect(keysFor(cmd, { prefix: "ctrl+a", leader: "space", bindings: {} })).toEqual([
    "<prefix>a",
    "<prefix>b",
  ]);
  expect(
    keysFor(cmd, { prefix: "ctrl+a", leader: "space", bindings: { "t.a": ["<prefix>z"] } }),
  ).toEqual(["<prefix>z"]);
  expect(keysFor(cmd, { prefix: "ctrl+a", leader: "space", bindings: { "t.a": [] } })).toEqual([]);
});

test("agent.new compiles its shifted-letter binding", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "agent.new",
        key: "<prefix>shift+n",
        desc: "start a native coding agent",
        group: "agents",
        run: Effect.sync(() => fired.push("agent.new")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("N", { shift: true });
    expect(fired).toEqual(["agent.new"]);
    expect(helpGroups(bindings, commands)[0]!.entries[0]!.keys).toBe("^a N");
  } finally {
    t.renderer.destroy();
  }
});

test("a user override replaces a plugin default instead of adding to it", async () => {
  const t = await createTestRenderer({ width: 20, height: 5 });
  const commands: CommandSpec[] = [
    {
      name: "plugin.agent.new",
      key: "<prefix>n",
      desc: "new agent",
      group: "agents",
      run: Effect.void,
    },
  ];
  const bindings = createBindings(t.renderer, commands, {
    keys: { prefix: "ctrl+a", leader: "space", bindings: { "plugin.agent.new": ["<prefix>g"] } },
    onUnhandled: () => false,
  });

  expect(
    helpGroups(bindings, commands, {
      prefix: "ctrl+a",
      leader: "space",
      bindings: { "plugin.agent.new": ["<prefix>g"] },
    })[0]!.entries[0],
  ).toMatchObject({ keys: "^a g", custom: true });
  expect(
    bindings.chords
      .activeBindings()
      .filter((binding) => binding.id.startsWith("cmd:plugin.agent.new:")),
  ).toHaveLength(1);
  bindings.dispose();
  t.renderer.destroy();
});

test("agent.prompt compiles its shifted-letter binding", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const commands: CommandSpec[] = [
      {
        name: "agent.prompt",
        key: "<prefix>shift+e",
        desc: "prompt the focused native agent",
        group: "agents",
        run: Effect.sync(() => fired.push("agent.prompt")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("E", { shift: true });
    expect(fired).toEqual(["agent.prompt"]);
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
        key: "<prefix>shift+i",
        desc: "interrupt the focused native agent",
        group: "agents",
        run: Effect.sync(() => fired.push("agent.interrupt")),
      },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("I", { shift: true });
    expect(fired).toEqual(["agent.interrupt"]);
    expect(helpGroups(bindings, commands)[0]!.entries[0]!.keys).toBe("^a I");
  } finally {
    t.renderer.destroy();
  }
});

function testContext(id: string, priority: number, active: () => boolean): ContextSpec {
  return { id, priority, active, rebindable: true };
}

test("a context-scoped binding only fires while its context is active", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    // A real Solid signal, not a plain closure over a mutable variable: the
    // layer's `enabled` field has to observe the change, which only a
    // reactive accessor can notify it of.
    const [insertMode, setInsertMode] = createSignal(false);
    const insert = testContext("editor.insert", CONTEXT_PRIORITY.PANE, insertMode);
    const commands: CommandSpec[] = [
      contextCommand(insert, {
        name: "delete-word",
        key: "d",
        desc: "delete word",
        group: "editor",
        run: Effect.sync(() => fired.push("delete-word")),
      }),
    ];
    createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

    expect(commands[0]!.name).toBe("editor.insert.delete-word");

    t.mockInput.pressKey("d");
    expect(fired).toEqual([]);

    setInsertMode(true);
    t.mockInput.pressKey("d");
    expect(fired).toEqual(["delete-word"]);
  } finally {
    t.renderer.destroy();
  }
});

test("two contexts binding the same key are not a conflict; the global layer is unaffected", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const normal = testContext("editor.normal", CONTEXT_PRIORITY.PANE, () => true);
    const visual = testContext("editor.visual", CONTEXT_PRIORITY.PANE, () => true);
    const commands: CommandSpec[] = [
      {
        name: "pane.up",
        key: "<prefix>k",
        desc: "focus up",
        group: "t",
        run: Effect.void,
      },
      contextCommand(normal, {
        name: "delete",
        key: "d",
        desc: "delete",
        group: "editor",
        run: Effect.void,
      }),
      contextCommand(visual, {
        name: "delete",
        key: "d",
        desc: "delete selection",
        group: "editor",
        run: Effect.void,
      }),
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

    expect(bindings.conflicts()).toEqual([]);
  } finally {
    t.renderer.destroy();
  }
});

test("a same-key collision within one context is still reported", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const normal = testContext("editor.normal", CONTEXT_PRIORITY.PANE, () => true);
    const commands: CommandSpec[] = [
      contextCommand(normal, {
        name: "delete-word",
        key: "d",
        desc: "delete word",
        group: "editor",
        run: Effect.void,
      }),
      contextCommand(normal, {
        name: "duplicate-line",
        key: "d",
        desc: "duplicate line",
        group: "editor",
        run: Effect.void,
      }),
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

    expect(bindings.conflicts()).toEqual([
      { sequence: "d", commands: ["editor.normal.delete-word", "editor.normal.duplicate-line"] },
    ]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * The keymap library only warns on an unknown layer field and registers the
 * layer anyway, active in every context. Nothing here writes a layer field
 * from user input, so the warning can only be this file's own typo — it must
 * fail loudly rather than stand as a silent global binding.
 */
test("a misspelled layer field fails loudly instead of silently going global", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const bindings = createBindings(t.renderer, [], {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    expect(() =>
      registerLayerChecked(bindings.keymap, {
        // Deliberately misspelled to exercise the guard: layer field names
        // are open-ended, so nothing here is a type error.
        enabld: () => true,
        bindings: [],
        commands: [],
      }),
    ).toThrow();
  } finally {
    t.renderer.destroy();
  }
});

/**
 * `nextKeys` reads `visibility: "active"`, not "registered" — "registered"
 * walks raw layers and evaluates no conditions, so a binding scoped to an
 * inactive context would read back as reachable and do nothing when pressed.
 * A hint that shows must be able to fire.
 */
test("nextKeys never surfaces a binding whose context is inactive", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const [copyModeActive, setCopyModeActive] = createSignal(false);
    const copyMode = testContext("copy-mode", CONTEXT_PRIORITY.APP_MODE, copyModeActive);
    const commands: CommandSpec[] = [
      contextCommand(copyMode, {
        name: "yank",
        key: "<prefix>y",
        desc: "yank selection",
        group: "copy",
        run: Effect.void,
      }),
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

    expect(nextKeys(bindings, commands, [], [{ display: "<prefix>" }])).toEqual([]);

    setCopyModeActive(true);
    expect(nextKeys(bindings, commands, [], [{ display: "<prefix>" }])).toEqual([
      { group: "copy", entries: [{ keys: ["y"], desc: "yank selection" }] },
    ]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * Before anything is typed, every leader-bound command's compiled sequence
 * starts with the same literal "<prefix>" token — showing each individually
 * would repeat that one key once per command. One collapsed entry says the
 * leader still reaches them, so a user inside an unfamiliar context still
 * sees it works (ts-20995a's decision: every active context, not just the
 * innermost one).
 */
test("nextKeys collapses leader-bound commands to one entry before the leader is pressed", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const commands: CommandSpec[] = [
      { name: "pane.split", key: "<prefix>|", desc: "split", group: "panes", run: Effect.void },
      { name: "pane.zoom", key: "<prefix>z", desc: "zoom", group: "panes", run: Effect.void },
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

    expect(nextKeys(bindings, commands, [], [])).toEqual([
      { group: "", entries: [{ keys: ["^a"], desc: "mux prefix" }] },
    ]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * A context with only a `handle` catch-all (key-context.ts) has no
 * CommandSpec to read a binding back from — copy mode's v/y/n, decided from
 * its own live state. `ContextSpec.hints` fills that gap for display, but
 * only before anything is typed: once a sequence is under way a typed prefix
 * has already said more than this static list can.
 */
test("nextKeys surfaces a handle-only context's declared hints, only before anything is typed", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const bindings = createBindings(t.renderer, [], {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    const [active, setActive] = createSignal(false);
    const copyMode: ContextSpec = {
      id: "copy-mode",
      active,
      priority: CONTEXT_PRIORITY.APP_MODE,
      rebindable: false,
      handle: () => true,
      hints: [{ keys: ["v"], desc: "start selection" }],
    };

    expect(nextKeys(bindings, [], [copyMode], [])).toEqual([]);

    setActive(true);
    expect(nextKeys(bindings, [], [copyMode], [])).toEqual([
      { group: "copy-mode", entries: [{ keys: ["v"], desc: "start selection" }] },
    ]);
    // Gone the moment a sequence starts — a static list has nothing more to
    // say about a half-typed prefix it knows nothing about.
    expect(nextKeys(bindings, [], [copyMode], [{ display: "x" }])).toEqual([]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * Groups sort by the highest `priority` among the contexts feeding them — a
 * context-less command sits beneath every real context, the same as its
 * layer does at dispatch. The panel says what will actually fire first.
 */
test("nextKeys orders groups by context precedence, context-less last", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const pane = testContext("editor.normal", CONTEXT_PRIORITY.PANE, () => true);
    const appMode = testContext("copy-mode", CONTEXT_PRIORITY.APP_MODE, () => true);
    const commands: CommandSpec[] = [
      { name: "app.quit", key: "q", desc: "quit", group: "global", run: Effect.void },
      contextCommand(pane, {
        name: "d",
        key: "d",
        desc: "delete",
        group: "editor",
        run: Effect.void,
      }),
      contextCommand(appMode, {
        name: "y",
        key: "y",
        desc: "yank",
        group: "copy",
        run: Effect.void,
      }),
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });

    expect(nextKeys(bindings, commands, [], []).map((g) => g.group)).toEqual([
      "copy",
      "editor",
      "global",
    ]);
  } finally {
    t.renderer.destroy();
  }
});

test("a context projects leader bindings as bare keys without hiding rebindings or multi-key tails", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const [active, setActive] = createSignal(false);
    const mode: ContextSpec = {
      id: "mode",
      active,
      priority: CONTEXT_PRIORITY.APP_MODE,
      rebindable: false,
      globalLeaderAliases: {},
    };
    const commands: CommandSpec[] = [
      {
        name: "pane.focus-left",
        key: "<prefix>h",
        desc: "focus left",
        group: "panes",
        run: Effect.sync(() => fired.push("focus-left")),
      },
      {
        name: "window.goto",
        key: "<prefix>gg",
        desc: "go to window",
        group: "windows",
        run: Effect.sync(() => fired.push("goto-window")),
      },
      contextCommand(mode, {
        name: "exit",
        key: "i",
        desc: "leave mode",
        group: "mode",
        run: Effect.sync(() => setActive(false)),
      }),
    ];
    const bindings = createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+b", leader: "space", bindings: { "pane.focus-left": ["<prefix>x"] } },
      onUnhandled: () => true,
    });

    t.mockInput.pressKey("b", { ctrl: true });
    t.mockInput.pressKey("x");
    expect(fired).toEqual(["focus-left"]);

    setActive(true);
    expect(
      bindings.chords
        .activeBindings()
        .filter((binding) => binding.id.includes("mode.alias.window.goto"))
        .map((binding) => [...binding.strokes]),
    ).toEqual([["g", "g"]]);
    t.mockInput.pressKey("x");
    t.mockInput.pressKey("g");
    t.mockInput.pressKey("g");
    expect(fired).toEqual(["focus-left", "focus-left", "goto-window"]);
    expect(
      nextKeys(bindings, bindings.commands(), [mode], []).flatMap((group) => group.entries),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keys: ["x"], desc: "focus left" }),
        expect.objectContaining({ keys: ["g"], desc: "go to window" }),
      ]),
    );
    expect(
      nextKeys(bindings, bindings.commands(), [mode], []).flatMap((group) => group.entries),
    ).not.toContainEqual(expect.objectContaining({ desc: "more commands" }));

    t.mockInput.pressKey("i");
    expect(active()).toBe(false);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * Arbitrary-length chords without intermediate ContextSpecs. Cite: neovim
 * `'timeoutlen'` / handle_mapping; OpenTUI registerNeovimDisambiguation wired
 * in createBindings.
 */
test("a long <leader> chord fires from one registration", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const normal: ContextSpec = {
      id: "editor.normal",
      active: () => true,
      priority: CONTEXT_PRIORITY.PANE,
      rebindable: false,
    };
    const bindings = createBindings(
      t.renderer,
      [
        contextCommand(normal, {
          name: "long",
          key: "<leader>asdf",
          desc: "long chord",
          group: "test",
          run: Effect.sync(() => fired.push("long")),
        }),
        contextCommand(normal, {
          name: "key.a",
          key: "a",
          desc: "append",
          group: "test",
          run: Effect.sync(() => fired.push("a")),
        }),
      ],
      {
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        onUnhandled: () => true,
        timeoutlenMs: 40,
      },
    );

    t.mockInput.pressKey(" ");
    for (const ch of "asdf") t.mockInput.pressKey(ch);
    await Bun.sleep(20);
    expect(fired).toEqual(["long"]);

    // Bare `a` still works when not mid-leader.
    t.mockInput.pressKey("a");
    expect(fired).toEqual(["long", "a"]);
    expect(bindings.keymap.getPendingSequence()).toEqual([]);
  } finally {
    t.renderer.destroy();
  }
});

test("timeoutlen prefers the longer chord, else the exact shorter binding", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const normal: ContextSpec = {
      id: "editor.normal",
      active: () => true,
      priority: CONTEXT_PRIORITY.PANE,
      rebindable: false,
    };
    createBindings(
      t.renderer,
      [
        contextCommand(normal, {
          name: "g",
          key: "g",
          desc: "g-prefix",
          group: "test",
          run: Effect.sync(() => fired.push("g")),
        }),
        contextCommand(normal, {
          name: "gg",
          key: "gg",
          desc: "first line",
          group: "test",
          run: Effect.sync(() => fired.push("gg")),
        }),
        contextCommand(normal, {
          name: "grr",
          key: "grr",
          desc: "references",
          group: "test",
          run: Effect.sync(() => fired.push("grr")),
        }),
      ],
      {
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        onUnhandled: () => true,
        timeoutlenMs: 40,
      },
    );

    t.mockInput.pressKey("g");
    t.mockInput.pressKey("g");
    await Bun.sleep(20);
    expect(fired).toEqual(["gg"]);

    fired.length = 0;
    t.mockInput.pressKey("g");
    t.mockInput.pressKey("r");
    t.mockInput.pressKey("r");
    await Bun.sleep(20);
    expect(fired).toEqual(["grr"]);

    fired.length = 0;
    t.mockInput.pressKey("g");
    await Bun.sleep(60);
    expect(fired).toEqual(["g"]);
  } finally {
    t.renderer.destroy();
  }
});

test("createBindings exposes a ChordMatcher with the same timeoutlen; CommandSpecs sync onto it", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const bindings = createBindings(
      t.renderer,
      [
        {
          name: "t.ab",
          key: "ab",
          desc: "ab",
          group: "t",
          run: Effect.sync(() => fired.push("ab")),
        },
      ],
      {
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        onUnhandled: () => true,
        timeoutlenMs: 40,
      },
    );
    expect(bindings.chords.timeoutlen()).toEqual(Duration.millis(40));
    expect(bindings.chords.push("a")._tag).toBe("pending");
    const matched = bindings.chords.push("b");
    expect(matched._tag).toBe("matched");
    if (matched._tag === "matched") expect(matched.id).toContain("t.ab");
    expect(fired).toEqual(["ab"]);
  } finally {
    t.renderer.destroy();
  }
});

/**
 * ChordMatcher map-fail: abandoned `<leader>` then unbound `j` retries `j`
 * (neovim handle_mapping). createBindings syncs `<leader>*` CommandSpecs onto
 * chords and feeds them from the global chord intercept.
 */
test("space then unbound j retries j via ChordMatcher (neovim map-fail)", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const normal: ContextSpec = {
      id: "editor.normal",
      active: () => true,
      priority: CONTEXT_PRIORITY.PANE,
      rebindable: false,
    };
    const bindings = createBindings(
      t.renderer,
      [
        contextCommand(normal, {
          name: "open",
          key: "<leader>e",
          desc: "open",
          group: "editor",
          run: Effect.sync(() => fired.push("open")),
        }),
        contextCommand(normal, {
          name: "key.j",
          key: "j",
          desc: "down",
          group: "editor",
          run: Effect.sync(() => fired.push("j")),
        }),
      ],
      {
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        onUnhandled: () => true,
        timeoutlenMs: 40,
      },
    );

    t.mockInput.pressKey(" ");
    t.mockInput.pressKey("j");
    await Bun.sleep(10);
    expect(fired).toEqual(["j"]);
    expect(bindings.chords.pending()).toEqual([]);

    t.mockInput.pressKey(" ");
    t.mockInput.pressKey("e");
    await Bun.sleep(10);
    expect(fired).toEqual(["j", "open"]);
  } finally {
    t.renderer.destroy();
  }
});

test("which-key lists leader continuations from ChordMatcher pending", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const normal: ContextSpec = {
      id: "editor.normal",
      active: () => true,
      priority: CONTEXT_PRIORITY.PANE,
      rebindable: false,
    };
    const bindings = createBindings(
      t.renderer,
      [
        contextCommand(normal, {
          name: "open",
          key: "<leader>e",
          desc: "open an editor pane",
          group: "editor",
          run: Effect.void,
        }),
        contextCommand(normal, {
          name: "find-file",
          key: "<leader>/",
          desc: "find file in project",
          group: "editor",
          run: Effect.void,
        }),
      ],
      {
        keys: { prefix: "ctrl+s", leader: "space", bindings: {} },
        onUnhandled: () => true,
        timeoutlenMs: 5000,
      },
    );

    t.mockInput.pressKey(" ");
    await Bun.sleep(10);
    expect(bindings.chords.pending()).toEqual(["<leader>"]);
    expect(nextKeys(bindings, bindings.commands(), [normal], [{ display: "<leader>" }])).toEqual([
      {
        group: "editor",
        entries: [
          { keys: ["e"], desc: "open an editor pane" },
          { keys: ["/"], desc: "find file in project" },
        ],
      },
    ]);
  } finally {
    t.renderer.destroy();
  }
});

test("pending grammar is display-only and independent of chord pending", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const bindings = createBindings(t.renderer, [], {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    let grammar: readonly string[] = [];
    const seen: string[][] = [];
    const stopGrammar = bindings.pending.register({
      id: "test.grammar",
      role: "grammar",
      strokes: () => grammar,
    });
    const stop = bindings.pending.subscribe(() => {
      seen.push([...pendingStrokes(bindings.pending, "grammar")]);
    });
    grammar = ["d"];
    bindings.pending.notify();
    grammar = ["3", "d"];
    bindings.pending.notify();
    bindings.pending.notify(); // same strokes — still notifies; equality is the source's job
    expect(pendingStrokes(bindings.pending, "grammar")).toEqual(["3", "d"]);
    expect(bindings.chords.pending()).toEqual([]);
    expect(pendingStrokes(bindings.pending, "chord")).toEqual([]);
    expect(seen).toEqual([["d"], ["3", "d"], ["3", "d"]]);
    stop();
    stopGrammar();
  } finally {
    t.renderer.destroy();
  }
});

test("pending table rejects a second source for the same role", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const bindings = createBindings(t.renderer, [], {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    // chord + count are already claimed by createBindings.
    expect(() =>
      bindings.pending.register({
        id: "test.chord.dupe",
        role: "chord",
        strokes: () => [],
      }),
    ).toThrow(/pending role 'chord' is already registered by 'amux.bindings.chord'/);

    const table = createPendingTable();
    table.register({ id: "a", role: "grammar", strokes: () => ["x"] });
    expect(() => table.register({ id: "b", role: "grammar", strokes: () => ["y"] })).toThrow(
      /pending role 'grammar' is already registered by 'a'/,
    );
  } finally {
    t.renderer.destroy();
  }
});

/**
 * Isolation at dispatch grain (paper Definition 25). The realm is read when
 * the key fires, not when the table was built, so the same command reaches a
 * different binding depending on which pane the user typed into. That is what
 * replaces resolving "the focused one" by hand inside every command body.
 */
test("a command that declares Realm reads the binding for the pane it ran in", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    class Thing extends Context.Service<Thing, { readonly of: string }>()("test/Thing") {}
    const panes = new Map([
      ["%1", realmOf("pane:%1", Context.make(Thing, { of: "left" }))],
      ["%2", realmOf("pane:%2", Context.make(Thing, { of: "right" }))],
    ]);
    let focused = "%1";
    const seen: Array<string | undefined> = [];
    const table = makeCommands({}, { realmForPane: (paneId) => panes.get(paneId) ?? NO_REALM });
    const commands: CommandSpec[] = [
      {
        name: "t.which",
        key: "<prefix>w",
        desc: "which",
        group: "t",
        run: Effect.gen(function* () {
          const realm = yield* Realm;
          seen.push(Option.getOrUndefined(realm.get(Thing))?.of);
        }),
      },
    ];
    createBindings(t.renderer, commands, {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
      pane: () => focused,
      withRealm: table.withRealm,
    });

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("w");
    focused = "%2";
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("w");
    // No pane focused at all: the command still runs, and reads nothing.
    focused = "%3";
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("w");

    expect(seen).toEqual(["left", "right", undefined]);
  } finally {
    t.renderer.destroy();
  }
});
