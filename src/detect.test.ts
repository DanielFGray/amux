import { test, expect } from "bun:test"
import { which } from "bun"
import { mkdtemp, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { splitActivity, looksBlocked, identifyAgent } from "./detect.ts"
import { Agent } from "./agent.ts"

test("a leading braille spinner marks the agent working and is stripped from the title", () => {
  for (const frame of ["⠋", "⠙", "⠹", "⠿"]) {
    const { spinning, text } = splitActivity(`${frame} building the thing`)
    expect(spinning).toBe(true)
    expect(text).toBe("building the thing")
  }
})

test("Claude Code's own activity glyphs count as spinners", () => {
  for (const glyph of ["·", "✢", "✳", "✶", "✻", "✽"]) {
    expect(splitActivity(`${glyph} task`)).toEqual({ spinning: true, text: "task" })
  }
})

test("a symbol that is part of the title is left alone", () => {
  // Only a single leading glyph followed by whitespace counts, so a title that
  // legitimately opens with a symbol keeps its text and reports not-working.
  expect(splitActivity("★ production")).toEqual({ spinning: false, text: "★ production" })
  expect(splitActivity("✨ task")).toEqual({ spinning: false, text: "✨ task" })
  expect(splitActivity("nvim ~/src")).toEqual({ spinning: false, text: "nvim ~/src" })
  // Two spinners: only the first is stripped, matching herdr's behaviour.
  expect(splitActivity("⠋ ⠙ task")).toEqual({ spinning: true, text: "⠙ task" })
})

test("empty and whitespace titles are not spinners", () => {
  expect(splitActivity("")).toEqual({ spinning: false, text: "" })
  expect(splitActivity("   ")).toEqual({ spinning: false, text: "" })
})

test("confirmation prompts read as blocked", () => {
  expect(looksBlocked(["", "Do you want to proceed?", "❯ 1. Yes", "  2. No", ""])).toBe(true)
  expect(looksBlocked(["Overwrite existing file? [y/N]"])).toBe(true)
  expect(looksBlocked(["Press enter to continue"])).toBe(true)
  expect(looksBlocked(["Waiting for your approval"])).toBe(true)
})

test("ordinary output does not read as blocked", () => {
  expect(looksBlocked([])).toBe(false)
  expect(looksBlocked(["", "   ", ""])).toBe(false)
  expect(looksBlocked(["$ ls", "README.md  src", "$ "])).toBe(false)
  expect(looksBlocked(["running 42 tests", "all passed"])).toBe(false)
})

test("agent CLIs are recognised by executable name, and nothing else is", () => {
  expect(identifyAgent("claude")).toBe("claude")
  expect(identifyAgent("/home/x/.bun/bin/claude --resume")).toBe("claude")
  expect(identifyAgent("cursor-agent")).toBe("cursor")
  expect(identifyAgent("OpenCode")).toBe("opencode")
  // The things that used to light up a spinner merely by existing.
  expect(identifyAgent("nvim")).toBe(null)
  expect(identifyAgent("bash")).toBe(null)
  expect(identifyAgent("cargo build")).toBe(null)
  expect(identifyAgent("")).toBe(null)
})

/**
 * A stand-in for an agent CLI: a copy of bash under an agent's name, so a test
 * can drive what ends up on its screen.
 *
 * A copy rather than a wrapper script, because detection reads the foreground
 * process's argv — and a script that `exec`s bash leaves nothing behind with the
 * agent's name on it, which is exactly the right answer for a wrapper and the
 * wrong shape for a fixture.
 */
async function fakeAgent(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-detect-"))
  const path = join(dir, name)
  const bash = which("bash")
  if (!bash) throw new Error("no bash on PATH to impersonate")
  await Bun.write(path, Bun.file(bash))
  await chmod(path, 0o755)
  return path
}

test("a plain shell is idle whatever it is running", async () => {
  // The old behaviour reported any foreground process as "working", so opening
  // nvim in a pane put a spinner next to it. Only agents get a state now.
  const agent = new Agent({ name: "t", cmd: ["bash", "--norc", "--noprofile"] })
  try {
    await Bun.sleep(400)
    expect(agent.state).toBe("idle")
    agent.write("sleep 3\n")
    await Bun.sleep(400)
    expect(agent.state).toBe("idle")
    // Still visible as a running process — it is only the state that changed.
    expect(agent.foregroundCommand).toBe("sleep")
    expect(agent.agentKind).toBe(null)
  } finally {
    agent.dispose()
  }
})

test("a blocked prompt on an agent's screen reads as blocked", async () => {
  const agent = new Agent({
    name: "t",
    cmd: [await fakeAgent("claude"), "--norc", "--noprofile"],
  })
  try {
    await Bun.sleep(300)
    expect(agent.agentKind).toBe("claude")
    agent.write("printf 'Do you want to proceed?\\n'\n")
    await Bun.sleep(500)
    expect(agent.state).toBe("blocked")
  } finally {
    agent.dispose()
  }
})

test("an agent started from a shell is picked up from the foreground process", async () => {
  const claude = await fakeAgent("claude")
  const agent = new Agent({ name: "t", cmd: ["bash", "--norc", "--noprofile"] })
  try {
    await Bun.sleep(300)
    expect(agent.agentKind).toBe(null)
    agent.write(`${claude} --norc --noprofile\n`)
    await Bun.sleep(700)
    expect(agent.agentKind).toBe("claude")
  } finally {
    agent.dispose()
  }
})

test("an exited agent is done regardless of what is left on screen", async () => {
  const agent = new Agent({ name: "t", cmd: ["sh", "-c", "printf 'Press enter to continue\\n'"] })
  try {
    await Bun.sleep(500)
    expect(agent.state).toBe("done")
  } finally {
    agent.dispose()
  }
})
