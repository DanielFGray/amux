import { test, expect } from "bun:test"
import { splitActivity, looksBlocked } from "./detect.ts"
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

test("a shell reports idle at a prompt and working while a command runs", async () => {
  const agent = new Agent({ name: "t", cmd: ["bash", "--norc", "--noprofile"] })
  try {
    await Bun.sleep(400)
    expect(agent.state).toBe("idle")
    agent.write("sleep 3\n")
    await Bun.sleep(400)
    expect(agent.state).toBe("working")
    expect(agent.foregroundCommand).toBe("sleep")
  } finally {
    agent.dispose()
  }
})

test("a blocked prompt on screen beats the process heuristic", async () => {
  // The shell sits at its own prompt, so the pgid check says "idle" — but the
  // screen is asking a question, and that is what actually matters.
  const agent = new Agent({ name: "t", cmd: ["bash", "--norc", "--noprofile"] })
  try {
    await Bun.sleep(300)
    agent.write("printf 'Do you want to proceed?\\n'\n")
    await Bun.sleep(500)
    expect(agent.state).toBe("blocked")
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
