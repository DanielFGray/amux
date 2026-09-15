/**
 * Jump list / change list — positions the user left via far motions or edits.
 * Cap keeps memory bounded; Ctrl-o/i and g;/g, walk the lists.
 */
import type { Cursor } from "./schema.ts";

const CAP = 100;

export type JumpList = {
  readonly entries: readonly Cursor[];
  readonly index: number;
};

export type ChangeList = {
  readonly entries: readonly Cursor[];
  readonly index: number;
};

export const emptyJumpList = (): JumpList => ({ entries: [], index: -1 });
export const emptyChangeList = (): ChangeList => ({ entries: [], index: -1 });

const same = (a: Cursor, b: Cursor): boolean => a.row === b.row && a.col === b.col;

/** Record the position we are about to leave. Truncates forward history. */
export function pushJump(list: JumpList, cursor: Cursor): JumpList {
  const tip = list.index >= 0 ? list.entries[list.index] : undefined;
  if (tip !== undefined && same(tip, cursor)) return list;
  const base = list.entries.slice(0, list.index + 1);
  const entries = [...base, { ...cursor }].slice(-CAP);
  return { entries, index: entries.length - 1 };
}

/**
 * Walk older. On the first step back from a jump destination, the current
 * cursor is appended so Ctrl-i can return.
 */
export function jumpOlder(
  list: JumpList,
  current: Cursor,
): { readonly list: JumpList; readonly cursor: Cursor } | null {
  if (list.entries.length === 0 || list.index < 0) return null;
  let entries = list.entries;
  const tip = entries[list.index]!;
  if (list.index === entries.length - 1 && !same(tip, current)) {
    entries = [...entries, { ...current }].slice(-CAP);
    return { list: { entries, index: list.index }, cursor: tip };
  }
  if (list.index <= 0) return null;
  const index = list.index - 1;
  return { list: { entries, index }, cursor: entries[index]! };
}

export function jumpNewer(
  list: JumpList,
): { readonly list: JumpList; readonly cursor: Cursor } | null {
  if (list.index + 1 >= list.entries.length) return null;
  const index = list.index + 1;
  return { list: { ...list, index }, cursor: list.entries[index]! };
}

/** Edits that leave a meaningful cursor — g; / g, walk this. */
export function pushChange(list: ChangeList, cursor: Cursor): ChangeList {
  const tip = list.entries[list.entries.length - 1];
  if (tip !== undefined && same(tip, cursor)) {
    return { ...list, index: list.entries.length - 1 };
  }
  const entries = [...list.entries, { ...cursor }].slice(-CAP);
  return { entries, index: entries.length - 1 };
}

export function changeOlder(
  list: ChangeList,
): { readonly list: ChangeList; readonly cursor: Cursor } | null {
  if (list.entries.length === 0) return null;
  const index = list.index < 0 ? list.entries.length - 1 : list.index;
  if (index < 0) return null;
  // First walk: land on tip; subsequent: older.
  if (list.index < 0 || list.index >= list.entries.length) {
    const i = list.entries.length - 1;
    return { list: { ...list, index: i }, cursor: list.entries[i]! };
  }
  if (list.index <= 0) return { list, cursor: list.entries[0]! };
  const next = list.index - 1;
  return { list: { ...list, index: next }, cursor: list.entries[next]! };
}

export function changeNewer(
  list: ChangeList,
): { readonly list: ChangeList; readonly cursor: Cursor } | null {
  if (list.entries.length === 0) return null;
  if (list.index < 0) return null;
  if (list.index + 1 >= list.entries.length) return null;
  const index = list.index + 1;
  return { list: { ...list, index }, cursor: list.entries[index]! };
}
