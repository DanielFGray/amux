/**
 * The commands that change the workspace actually change it.
 *
 * Written for ts-456094, where every closing command was a no-op: Phase 5b
 * turned closeWindow, breakPane, killAgent and remove into Effects and the
 * eight call sites in app.tsx went on calling them as statements. An Effect
 * nobody runs does nothing, and an unused expression statement is legal
 * TypeScript, so neither the typecheck nor the suite said a word.
 *
 * Each step is checked against the persisted workspace rather than the screen,
 * and the steps build on each other so a command that half-worked shows up as
 * the wrong shape at the next one.
 *
 *   bun run e2e:workspace
 */
import { launch, report, LEADER } from "./app.ts"

const app = await launch("e2e-workspace")

async function step(keys: string, label: string): Promise<string> {
  await app.press(keys)
  const shape = await app.shape()
  console.log(`${label.padEnd(26)} -> ${shape}`)
  return shape
}

console.log(`${"boot".padEnd(26)} -> ${await app.shape()}`)

const opened = await step(`${LEADER}c`, "^a c  new window")
const closed = await step(`${LEADER}&`, "^a & kill window")
const split = await step(`${LEADER}|`, "^a | split")
const broken = await step(`${LEADER}!`, "^a ! break pane")
const killed = await step(`${LEADER}K`, "^a K kill agent")

await app.stop()

report([
  ["new window adds a window and an agent", opened === "1sp 2win 2ag"],
  ["kill window takes its agent with it", closed === "1sp 1win 1ag"],
  ["split adds an agent to the window", split === "1sp 1win 2ag"],
  ["break moves the pane into a window of its own", broken === "1sp 2win 2ag"],
  // The window left behind is EXPECTED here, and is filed as ts-8d06b3:
  // killAgent does not join the exit cascade, so killing the last agent in a
  // window leaves that window empty. Asserted as it is rather than as it ought
  // to be, so this check keeps testing what it is about; ts-8d06b3 flips it.
  ["kill agent removes the agent (leaves its window: ts-8d06b3)", killed === "1sp 2win 1ag"],
])
