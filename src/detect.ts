/**
 * Working out what an agent is doing from what it puts on screen.
 *
 * The obvious signal — is a foreground process group running? — is useless for
 * agent CLIs. `claude` and `codex` are a single long-lived foreground process,
 * so a pgid comparison says "working" for the entire session, whether the model
 * is thinking or the prompt has been sitting idle for an hour.
 *
 * herdr solves this two ways. Where it can, it installs lifecycle hooks that
 * authoritatively report idle/working/blocked; for agents it cannot hook, it
 * falls back to reading the activity spinner out of an OSC title and matching
 * known "waiting for you" prompts against the screen. That fallback is the one
 * we project here — a supervised PTY has no hooks to lean on.
 */

export type AgentState = "idle" | "working" | "blocked" | "detached" | "done"

/**
 * Executable names that mean "this is an agent CLI", mapped to a short label.
 *
 * State detection is only meaningful for these. Everything else running in a
 * pane — nvim, less, a build — is just a process, and reporting it as "working"
 * puts a spinner next to a text editor that is patiently doing nothing. herdr
 * carries the same table (src/detect/mod.rs, `lookup_agent`); this is the subset
 * whose binaries anyone here is likely to have, and it is cheap to extend.
 */
const AGENT_EXECUTABLES: Record<string, string> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  "open-code": "opencode",
  cursor: "cursor",
  "cursor-agent": "cursor",
  amp: "amp",
  droid: "droid",
  copilot: "copilot",
  "github-copilot": "copilot",
  grok: "grok",
  kimi: "kimi",
  aider: "aider",
  goose: "goose",
  pi: "pi",
  cline: "cline",
}

/** Runtimes an agent is commonly launched through, where the name worth reading
 *  is the script in argv[1] rather than the binary in argv[0]. */
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "sh", "bash", "zsh"])

const executableName = (token: string): string =>
  token
    .split("/")
    .pop()!
    .replace(/\.(exe|cmd|js|mjs|ts)$/i, "")
    .toLowerCase()

/**
 * Recognise an agent CLI from a command name or a whole command line.
 *
 * argv[1] is consulted only when argv[0] is a known runtime, because plenty of
 * agents ship as `node /path/to/bin/codex`. Scanning further would start
 * matching arguments — `nvim claude.md` is not an agent — so the walk stops
 * there.
 */
export function identifyAgent(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  const first = tokens[0]
  if (!first) return null
  const base = executableName(first)
  const direct = AGENT_EXECUTABLES[base]
  if (direct) return direct
  if (!INTERPRETERS.has(base) || !tokens[1]) return null
  return AGENT_EXECUTABLES[executableName(tokens[1])] ?? null
}

/**
 * A readable name for whatever a pane was launched as: "zsh", "claude", "nvim".
 *
 * Every pane used to be labelled "shell" until its child got round to setting an
 * OSC title, which said nothing — the interesting part is *which* shell, and the
 * command line already carries it. Login shells arrive as argv[0] "-zsh", so the
 * conventional leading dash is stripped.
 */
export function commandName(cmd: readonly string[]): string {
  const first = cmd[0]?.trim()
  if (!first) return "shell"
  return executableName(first.replace(/^-/, "")) || "shell"
}

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
  detached: "⊘",
  done: "✓",
}
