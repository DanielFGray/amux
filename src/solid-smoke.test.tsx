/** @jsxImportSource @opentui/solid */
import { test, expect } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"

/**
 * Proves the Solid toolchain is actually wired up, not just compiling.
 *
 * A JSX transform that produces plain elements instead of Solid's reactive
 * output still typechecks and still renders once — it just never updates. This
 * asserts the update, which is the only part that can silently regress.
 */
test("solid renders and reacts to a signal change without any manual repaint", async () => {
  const [count, setCount] = createSignal(0)
  const t = await testRender(() => <text>count is {count()}</text>, { width: 40, height: 6 })
  try {
    await t.waitForFrame((f: string) => f.includes("count is 0"))
    setCount(7)
    // No requestRender, no dirty flag: if this frame arrives, reactivity works.
    await t.waitForFrame((f: string) => f.includes("count is 7"))
    expect(t.captureCharFrame()).toContain("count is 7")
  } finally {
    t.renderer.destroy()
  }
})
