import type { ActiveCompletion } from "./types.ts";

/**
 * The token immediately before the cursor: a trigger character preceded by
 * the start of the text or whitespace, followed by a non-space run. Runs on
 * the text before the cursor, so a cursor parked mid-line completes the
 * token it sits in rather than the end of the line.
 */
export const activeCompletion = (text: string, cursor: number): ActiveCompletion | undefined => {
  const at = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, at);
  const match = /(^|\s)([/@])([^\s]*)$/.exec(before);
  if (!match) return undefined;
  const trigger = match[2];
  if (trigger !== "/" && trigger !== "@") return undefined;
  const query = match[3] ?? "";
  return { trigger, query, start: at - trigger.length - query.length, end: at };
};

/** Splice the replacement over the token range, preserving text on both sides. */
export const replaceCompletion = (
  text: string,
  active: ActiveCompletion,
  replacement: string,
): string => `${text.slice(0, active.start)}${replacement}${text.slice(active.end)}`;
