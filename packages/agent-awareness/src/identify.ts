import { Config, ConfigProvider, Effect, Option } from "effect";

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

const shell = Effect.runSync(
  Config.option(Config.string("SHELL")).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
  ),
);

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
  Option.isSome(shell) ? (shell.value.split("/").pop()?.toLowerCase() ?? "") : "",
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

export function identifyAgent(command: string | readonly string[]): string | null {
  const tokens =
    typeof command === "string" ? command.trim().split(/\s+/).filter(Boolean) : command;
  const first = tokens[0];
  if (!first) return null;
  const base = executableName(first);
  const direct = hasOwn(AGENT_EXECUTABLES, base) ? AGENT_EXECUTABLES[base] : undefined;
  if (direct) return direct;
  if (!INTERPRETERS.has(base) || !tokens[1]) return null;
  const script = executableName(tokens[1]);
  return hasOwn(AGENT_EXECUTABLES, script) ? AGENT_EXECUTABLES[script] : null;
}

const CLAUDE_ACTIVITY_GLYPHS = "·✢✳✶✻✽";

const isActivityGlyph = (ch: string): boolean => {
  const cp = ch.codePointAt(0);
  return (
    cp !== undefined && ((cp >= 0x2800 && cp <= 0x28ff) || CLAUDE_ACTIVITY_GLYPHS.includes(ch))
  );
};

export function splitActivity(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return { spinning: false, text: "" };
  const first = String.fromCodePoint(trimmed.codePointAt(0)!);
  const rest = trimmed.slice(first.length);
  if (!isActivityGlyph(first) || (rest && !/^\s/.test(rest)))
    return { spinning: false, text: trimmed };
  return { spinning: true, text: rest.trim() };
}
