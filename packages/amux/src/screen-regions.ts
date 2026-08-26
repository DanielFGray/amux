/** Named, structural views of a terminal screen for state detectors. */
export interface ScreenSnapshot {
  readonly lines: readonly string[];
  readonly oscTitle: string;
  readonly oscProgress: string;
}

export type ScreenRegion =
  | "osc_title"
  | "osc_progress"
  | "prompt_box_body"
  | "after_last_horizontal_rule"
  | "after_last_prompt_marker"
  | "above_prompt_box"
  | "last_non_empty_above_prompt_box"
  | "whole_recent"
  | `bottom_non_empty_lines(${number})`
  | `bottom_lines(${number})`;

export function extractScreenRegion(snapshot: ScreenSnapshot, region: ScreenRegion): string {
  if (region === "osc_title") return snapshot.oscTitle;
  if (region === "osc_progress") return snapshot.oscProgress;

  const lines = snapshot.lines;
  if (region === "whole_recent") return join(lines);
  if (region === "after_last_prompt_marker") return join(afterLastPromptMarker(lines));
  if (region === "after_last_horizontal_rule") return join(afterLastHorizontalRule(lines));
  if (region === "prompt_box_body") return join(promptBoxBody(lines));
  if (region === "above_prompt_box") return join(abovePromptBox(lines));
  if (region === "last_non_empty_above_prompt_box")
    return (
      [...abovePromptBox(lines)]
        .reverse()
        .find((line) => line.trim())
        ?.trimEnd() ?? ""
    );

  const count = regionCount(region, "bottom_lines");
  if (count !== null) return join(lines.slice(-count));
  const nonEmptyCount = regionCount(region, "bottom_non_empty_lines");
  if (nonEmptyCount !== null) return join(bottomNonEmptyLines(lines, nonEmptyCount));
  return "";
}

function join(lines: readonly string[]): string {
  return lines.map((line) => line.trimEnd()).join("\n");
}

function regionCount(region: string, name: string): number | null {
  const match = new RegExp(`^${name}\\(([1-9]\\d*)\\)$`).exec(region);
  return match ? Number(match[1]) : null;
}

function bottomNonEmptyLines(lines: readonly string[], count: number): readonly string[] {
  let remaining = count;
  let start = lines.length;
  while (start > 0 && remaining > 0) {
    start--;
    if (lines[start]!.trim()) remaining--;
  }
  return remaining === 0 ? lines.slice(start) : lines;
}

function afterLastPromptMarker(lines: readonly string[]): readonly string[] {
  const index = lines.findLastIndex((line) => line === "›" || line.startsWith("› "));
  return index < 0 ? lines : lines.slice(index + 1);
}

function afterLastHorizontalRule(lines: readonly string[]): readonly string[] {
  const index = lines.findLastIndex(isHorizontalRule);
  return index < 0 ? lines : lines.slice(index + 1);
}

function promptBoxBody(lines: readonly string[]): readonly string[] {
  const top = promptBoxTop(lines);
  if (top < 0) return [];
  const offset = lines.slice(top + 1).findIndex(isHorizontalRule);
  const bottom = offset < 0 ? undefined : top + 1 + offset;
  return lines.slice(top + 1, bottom);
}

function abovePromptBox(lines: readonly string[]): readonly string[] {
  const top = promptBoxTop(lines);
  return top < 0 ? lines : lines.slice(0, top);
}

function promptBoxTop(lines: readonly string[]): number {
  let borders = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!isHorizontalRule(lines[index]!)) continue;
    borders++;
    if (borders === 2) return index;
  }
  return -1;
}

function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  const ruleLength = trimmed.match(/^─+/)?.[0].length ?? 0;
  return ruleLength > 0 && (ruleLength >= 3 || trimmed.slice(ruleLength).trim() === "");
}
