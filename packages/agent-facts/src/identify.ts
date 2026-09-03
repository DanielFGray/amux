import { AgentManifests } from "./manifests.ts";

export function identifyAgent(command: string | readonly string[]): string | null {
  return AgentManifests.identifyAgent(command);
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
