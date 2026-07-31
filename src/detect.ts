/**
 * Working out what an agent is doing from what it puts on screen.
 *
 * The obvious signal — is a foreground process group running? — is useless for
 * agent CLIs. `claude` and `codex` are a single long-lived foreground process,
 * so a pgid comparison says "working" for the entire session, whether the model
 * is thinking or the prompt has been sitting idle for an hour. herdr solves
 * this by reading the agent's own activity spinner out of its OSC title, and
 * matching known "waiting for you" prompts against the screen. Same approach
 * here.
 */

export type AgentState = "idle" | "working" | "blocked" | "done"

/** Non-braille glyphs Claude Code cycles through in its title while thinking. */
const CLAUDE_ACTIVITY_GLYPHS = "·✢✳✶✻✽"

/** Braille spinners occupy U+2800–U+28FF; most agent CLIs animate one there. */
const isActivityGlyph = (ch: string): boolean => {
  const cp = ch.codePointAt(0)
  if (cp === undefined) return false
  return (cp >= 0x2800 && cp <= 0x28ff) || CLAUDE_ACTIVITY_GLYPHS.includes(ch)
}

/**
 * Split a leading activity glyph off a terminal title.
 *
 * Only a *single* leading glyph that is followed by whitespace or ends the
 * string counts, so a title that legitimately starts with a symbol ("★ prod")
 * is left alone and a spinner is not mistaken for content.
 */
export function splitActivity(title: string): { spinning: boolean; text: string } {
  const trimmed = title.trim()
  if (!trimmed) return { spinning: false, text: "" }
  const first = String.fromCodePoint(trimmed.codePointAt(0)!)
  const rest = trimmed.slice(first.length)
  if (!isActivityGlyph(first)) return { spinning: false, text: trimmed }
  if (rest && !/^\s/.test(rest)) return { spinning: false, text: trimmed }
  return { spinning: true, text: rest.trim() }
}

/**
 * Screen patterns that mean the agent has stopped and is waiting on a human.
 *
 * This is a starting set covering the confirmation prompts of the agent CLIs
 * in daily use, not a complete manifest — herdr carries a much larger one with
 * per-tool priority arbitration. Anything unmatched simply falls through to the
 * process-based heuristic, so a missing pattern costs a wrong dot, not a hang.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /Do you want to (proceed|continue|make this edit)/i,
  /❯\s*1\.\s*Yes/,
  /\bAllow\b.*\?\s*$/im,
  /\[y\/n\]/i,
  /\(y\/N\)/,
  /Press\s+(enter|return)\s+to\s+continue/i,
  /Waiting for (your )?(input|response|approval)/i,
]

/** True when the tail of the screen looks like a prompt awaiting an answer. */
export function looksBlocked(lines: string[]): boolean {
  // Trailing blank rows are the norm; join only what has content so a pattern
  // anchored at end-of-line still matches the real last line.
  const text = lines
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0)
    .join("\n")
  if (!text) return false
  return BLOCKED_PATTERNS.some((re) => re.test(text))
}

/** Braille frames for our own rendering of the "working" state. */
export const SPINNER_FRAMES = [...
  "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"]

export const STATE_GLYPH: Record<AgentState, string> = {
  blocked: "●",
  working: "⠹", // replaced with the live spinner frame when rendering
  idle: "○",
  done: "✓",
}
