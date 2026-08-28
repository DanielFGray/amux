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

/**
 * Executable names that mean "this is an agent CLI", mapped to a short label.
 *
 * State detection is only meaningful for these. Everything else running in a
 * pane — nvim, less, a build — is just a process, and reporting it as "working"
 * puts a spinner next to a text editor that is patiently doing nothing. herdr
 * carries the same table (src/detect/mod.rs, `lookup_agent`); this is the subset
 * whose binaries anyone here is likely to have, and it is cheap to extend.
 */
const AGENT_EXECUTABLES = {
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
} satisfies Record<string, string>;

/** Runtimes an agent is commonly launched through, where the name worth reading
 *  is the script in argv[1] rather than the binary in argv[0]. */
const INTERPRETERS = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "sh",
  "bash",
  "fish",
  "zsh",
  process.env.SHELL?.split("/").pop()?.toLowerCase() ?? "",
]);

function hasOwn<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return Object.hasOwn(record, key);
}

const executableName = (token: string): string =>
  token
    .split("/")
    .pop()!
    .replace(/\.(exe|cmd|js|mjs|ts)$/i, "")
    .toLowerCase();

/**
 * Recognise an agent CLI from a command name or a whole command line.
 *
 * argv[1] is consulted only when argv[0] is a known runtime, because plenty of
 * agents ship as `node /path/to/bin/codex`. Scanning further would start
 * matching arguments — `nvim claude.md` is not an agent — so the walk stops
 * there.
 */
export function identifyAgent(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first) return null;
  const base = executableName(first);
  const direct = hasOwn(AGENT_EXECUTABLES, base) ? AGENT_EXECUTABLES[base] : undefined;
  if (direct) return direct;
  if (!INTERPRETERS.has(base) || !tokens[1]) return null;
  const script = executableName(tokens[1]);
  return hasOwn(AGENT_EXECUTABLES, script) ? AGENT_EXECUTABLES[script] : null;
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
  const first = cmd[0]?.trim();
  if (!first) return "shell";
  return executableName(first.replace(/^-/, "")) || "shell";
}

/** Non-braille glyphs Claude Code cycles through in its title while thinking. */
const CLAUDE_ACTIVITY_GLYPHS = "·✢✳✶✻✽";

/** Braille spinners occupy U+2800–U+28FF; most agent CLIs animate one there. */
const isActivityGlyph = (ch: string): boolean => {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (cp >= 0x2800 && cp <= 0x28ff) || CLAUDE_ACTIVITY_GLYPHS.includes(ch);
};

/**
 * Split a leading activity glyph off a terminal title.
 *
 * Only a *single* leading glyph that is followed by whitespace or ends the
 * string counts, so a title that legitimately starts with a symbol ("★ prod")
 * is left alone and a spinner is not mistaken for content.
 */
export function splitActivity(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return { spinning: false, text: "" };
  const first = String.fromCodePoint(trimmed.codePointAt(0)!);
  const rest = trimmed.slice(first.length);
  if (!isActivityGlyph(first)) return { spinning: false, text: trimmed };
  if (rest && !/^\s/.test(rest)) return { spinning: false, text: trimmed };
  return { spinning: true, text: rest.trim() };
}
