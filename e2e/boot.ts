/**
 * The app boots, draws, runs a shell, and does it again on a second launch.
 *
 * The check the Effect-migration tasks call "the real-TUI boot check". It is
 * deliberately shallow — it presses almost nothing — because its job is to
 * catch the failures that make everything else moot: a service that cannot be
 * acquired, a scope that closes on the way up, a renderer that never draws.
 * ts-95af71's Definition of Done is the reason it exists.
 *
 *   bun run e2e:boot
 */
import { launch, report } from "./app.ts"

const MARKER = "MARKER-ONE"

async function boot(session: string, type?: string) {
  const app = await launch(session)
  if (type) await app.press(type)
  const out = app.output()
  const shape = await app.shape()
  await app.stop()
  return { out, shape }
}

// A shell prompt and a command that echoes something only we would write, so
// "the pane is wired to a process" is answered by the process itself.
const first = await boot("e2e-boot-1", `echo ${MARKER}\r`)
console.log(`first launch  -> ${first.shape}, ${first.out.length} bytes drawn`)

const second = await boot("e2e-boot-2")
console.log(`second launch -> ${second.shape}, ${second.out.length} bytes drawn`)

/** Anything the runtime prints when it gives up. Escape codes are stripped
 *  first: a crash report is plain text, and the screen around it is not. */
function crashed(out: string): string | null {
  const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
  const hit = plain.match(/(FiberFailure|Unhandled|TypeError|ReferenceError|panic:|is not a function)[^\n]*/)
  return hit?.[0] ?? null
}

report([
  ["the first launch draws a screen", first.out.length > 2000],
  ["it persists one space with one agent", first.shape === "1sp 1win 1ag"],
  ["the pane runs a real shell", first.out.includes(MARKER)],
  ["nothing crashed on the way up", crashed(first.out) === null],
  ["a second launch boots the same way", second.shape === "1sp 1win 1ag"],
  ["and nothing crashed there either", crashed(second.out) === null],
])
