/**
 * The app boots, draws, runs a shell, and does it again on a second launch.
 *
 * The check the Effect-migration tasks call "the real-TUI boot check". It is
 * deliberately shallow — it presses almost nothing — because its job is to
 * catch the failures that make everything else moot: a service that cannot be
 * acquired, a scope that closes on the way up, a renderer that never draws.
 * ts-95af71's Definition of Done is the reason it exists.
 *
 * Two launches, because booting once proves nothing about booting onto state a
 * previous run left behind.
 */
import { test, expect, beforeAll } from "bun:test"
import { launch, E2E_TIMEOUT } from "./app.ts"

const MARKER = "MARKER-ONE"

/** Anything the runtime prints when it gives up. Escape codes are stripped
 *  first: a crash report is plain text, and the screen around it is not. */
function crashed(out: string): string | null {
  const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
  const hit = plain.match(/(FiberFailure|Unhandled|TypeError|ReferenceError|panic:|is not a function)[^\n]*/)
  return hit?.[0] ?? null
}

async function boot(session: string, type?: string) {
  const app = await launch(session)
  if (type) {
    app.send(type)
    await app.until(() => app.output().includes(MARKER), "the shell marker to appear")
  }
  const out = app.output()
  const shape = await app.shape()
  await app.stop()
  return { out, shape }
}

let first: { out: string; shape: string }
let second: { out: string; shape: string }

beforeAll(async () => {
  // A shell prompt and a command that echoes something only we would write, so
  // "the pane is wired to a process" is answered by the process itself.
  first = await boot("e2e-boot-1", `echo ${MARKER}\r`)
  second = await boot("e2e-boot-2")
}, E2E_TIMEOUT)

test("the first launch draws a screen", () => {
  expect(first.out.length).toBeGreaterThan(2000)
})

test("it persists one space with one agent", () => {
  expect(first.shape).toBe("1sp 1win 1ag")
})

test("the pane runs a real shell", () => {
  expect(first.out).toContain(MARKER)
})

test("nothing crashed on the way up", () => {
  expect(crashed(first.out)).toBeNull()
})

test("a second launch boots the same way", () => {
  expect(second.shape).toBe("1sp 1win 1ag")
})

test("and nothing crashed there either", () => {
  expect(crashed(second.out)).toBeNull()
})
