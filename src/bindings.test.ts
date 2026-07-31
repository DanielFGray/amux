import { test, expect } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createBindings, helpGroups, type CommandSpec } from "./bindings.ts"

/**
 * A binding whose key string the parser rejects is not an error anyone sees —
 * the keymap logs and carries on, and the command is simply dead. So the thing
 * worth asserting is that every sequence we write actually compiled, which is
 * exactly what reading the bindings back out of the keymap tells us.
 */
test("every declared sequence compiles, including multi-char key names", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 })
  try {
    const commands: CommandSpec[] = [
      { name: "t.letter", key: "<leader>h", desc: "letter", group: "t", run: () => {} },
      { name: "t.arrow", key: "<leader>left", desc: "arrow", group: "t", run: () => {} },
      { name: "t.brace", key: ["<leader>{", "<leader>}"], desc: "brace", group: "t", run: () => {} },
    ]
    const keymap = createBindings(t.renderer, commands, { onUnhandled: () => true })
    const entries = helpGroups(keymap, commands)[0]!.entries

    expect(entries.map((e) => e.keys)).toEqual(["^a h", "^a left", "^a { / ^a }"])
  } finally {
    t.renderer.destroy()
  }
})

test("two commands on one sequence is refused rather than silently resolved", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 })
  try {
    const commands: CommandSpec[] = [
      { name: "pane.up", key: "<leader>k", desc: "focus up", group: "t", run: () => {} },
      { name: "agent.kill", key: "<leader>k", desc: "kill agent", group: "t", run: () => {} },
    ]
    expect(() => createBindings(t.renderer, commands, { onUnhandled: () => true })).toThrow(
      /\^a k -> pane\.up, agent\.kill/,
    )
  } finally {
    t.renderer.destroy()
  }
})

/**
 * A capital and its lowercase must be two different bindings.
 *
 * `^a S` (settings) was dead because a bare "S" in a key string compiles to the
 * very same sequence as "s", so `^a s` (new space) claimed both. It has to be
 * written `shift+s`, and read back as "S".
 */
test("shift+letter is a distinct binding from the bare letter", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 })
  try {
    const fired: string[] = []
    const commands: CommandSpec[] = [
      { name: "t.lower", key: "<leader>s", desc: "lower", group: "t", run: () => fired.push("s") },
      {
        name: "t.upper",
        key: "<leader>shift+s",
        desc: "upper",
        group: "t",
        run: () => fired.push("S"),
      },
    ]
    const keymap = createBindings(t.renderer, commands, { onUnhandled: () => true })

    t.mockInput.pressKey("a", { ctrl: true })
    t.mockInput.pressKey("s")
    t.mockInput.pressKey("a", { ctrl: true })
    t.mockInput.pressKey("S", { shift: true })
    expect(fired).toEqual(["s", "S"])

    // Written shift+s, shown as the key you actually press.
    expect(helpGroups(keymap, commands)[0]!.entries.map((e) => e.keys)).toEqual(["^a s", "^a S"])
  } finally {
    t.renderer.destroy()
  }
})

/**
 * A command hidden from help must still run.
 *
 * `^a 2`..`^a 9` were dead for exactly this reason: hiding them was done with
 * an empty desc, the keymap rejects empty metadata, and a rejected command
 * still compiles its binding — so every readback showed `^a 2` bound and
 * pressing it did nothing. Only dispatching the key catches that.
 */
test("a command hidden from help still dispatches", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 })
  try {
    const fired: string[] = []
    const commands: CommandSpec[] = [
      {
        name: "t.shown",
        key: "<leader>1",
        desc: "select 1..9",
        group: "t",
        run: () => fired.push("1"),
      },
      {
        name: "t.hidden",
        key: "<leader>2",
        desc: "select 2",
        hidden: true,
        group: "t",
        run: () => fired.push("2"),
      },
    ]
    const keymap = createBindings(t.renderer, commands, { onUnhandled: () => true })

    t.mockInput.pressKey("a", { ctrl: true })
    t.mockInput.pressKey("2")
    t.mockInput.pressKey("a", { ctrl: true })
    t.mockInput.pressKey("1")
    expect(fired).toEqual(["2", "1"])

    // ...while staying out of the listing it is hidden from.
    expect(helpGroups(keymap, commands)[0]!.entries).toEqual([
      { keys: "^a 1", desc: "select 1..9" },
    ])
  } finally {
    t.renderer.destroy()
  }
})
