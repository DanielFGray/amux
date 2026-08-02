/**
 * The commands that change the workspace actually change it.
 *
 * Written for ts-456094, where every closing command was a no-op: Phase 5b
 * turned closeWindow, breakPane, killAgent and remove into Effects and the
 * eight call sites in app.tsx went on calling them as statements. An Effect
 * nobody runs does nothing, and an unused expression statement is legal
 * TypeScript, so neither the typecheck nor the suite said a word.
 *
 * Each step is checked against the persisted workspace, and the steps build on
 * each other so a command that half-worked shows up as the wrong shape at the
 * next one. The file is the app's own account of its state rather than a
 * rendering of it, which is what makes a silent no-op visible.
 *
 * The sidebar footer is then checked against that same file. Two accounts of one
 * workspace that have to agree: the tree on screen and the state on disk. This
 * is the claim ts-9beb5d was filed about, and could not have been settled by
 * reading `output()` — see App.screen().
 *
 *   bun run e2e:workspace
 */
import { launch, report, LEADER } from "./app.ts"

const app = await launch("e2e-workspace")

/** "1sp 2win 2ag" as the sidebar footer would write it. */
function footerFor(shape: string): string {
  const [spaces, , agents] = shape.split(" ").map((part) => Number.parseInt(part, 10))
  return `${spaces} space${spaces === 1 ? "" : "s"} · ${agents} agent${agents === 1 ? "" : "s"}`
}

const footerAgreed: string[] = []

async function step(keys: string, label: string): Promise<string> {
  await app.press(keys)
  const shape = await app.shape()
  const footer = footerFor(shape)
  if (!app.screen().includes(footer)) footerAgreed.push(`${label.trim()} (want "${footer}")`)
  console.log(`${label.padEnd(26)} -> ${shape}`)
  return shape
}

console.log(`${"boot".padEnd(26)} -> ${await app.shape()}`)

const opened = await step(`${LEADER}c`, "^a c  new window")
const closed = await step(`${LEADER}&`, "^a & kill window")
const split = await step(`${LEADER}|`, "^a | split")
const broken = await step(`${LEADER}!`, "^a ! break pane")
const killed = await step(`${LEADER}K`, "^a K kill agent")

// Killing the LAST agent runs the cascade to its end: the window closes, then
// the space, then the app itself. That escalation is the point of ts-8d06b3 —
// it is what typing `exit` in the only shell already did, and a kill has to
// mean the same thing — but it is also the most surprising thing in this file,
// so it is checked rather than assumed. Last step: nothing survives it.
await app.press(`${LEADER}K`)
const emptied = await app.shape()
console.log(`${"^a K kill last agent".padEnd(26)} -> ${emptied}`)

await app.stop()

if (footerAgreed.length) console.log(`\nfooter disagreed after: ${footerAgreed.join(", ")}`)

report([
  ["new window adds a window and an agent", opened === "1sp 2win 2ag"],
  ["kill window takes its agent with it", closed === "1sp 1win 1ag"],
  ["split adds an agent to the window", split === "1sp 1win 2ag"],
  ["break moves the pane into a window of its own", broken === "1sp 2win 2ag"],
  // ts-8d06b3: killing the last agent in a window takes the window with it,
  // exactly as the agent exiting on its own would. This asserted the window
  // being left behind until killAgent joined the exit cascade.
  ["kill agent takes its emptied window with it", killed === "1sp 1win 1ag"],
  ["killing the last agent empties the workspace and quits", emptied === "0sp 0win 0ag"],
  ["the sidebar footer agrees with the session file at every step", footerAgreed.length === 0],
])
