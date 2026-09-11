import type { PickerView } from "./types.ts";

/**
 * Narrow the view to entries whose text contains the query, case-insensitive,
 * and reset the selection: a new result set never inherits the old cursor.
 */
export const filterEntries = <TEntry>(
  view: PickerView<TEntry>,
  query: string,
  text: (entry: TEntry) => string,
): PickerView<TEntry> => {
  const needle = query.trim().toLowerCase();
  const entries = view.allEntries.filter((entry) => text(entry).toLowerCase().includes(needle));
  return { ...view, entries, query, selected: 0 };
};

/** Move the selection by delta, clamped to the list. An empty list stays at 0. */
export const moveSelected = <TEntry>(
  view: PickerView<TEntry>,
  delta: number,
): PickerView<TEntry> => ({
  ...view,
  selected: Math.max(0, Math.min(view.entries.length - 1, view.selected + delta)),
});
