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
