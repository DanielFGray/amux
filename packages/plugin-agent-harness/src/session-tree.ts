/**
 * Pure session-tree algebra for harness history — Pi session-format semantics
 * without making Pi JSONL authoritative.
 *
 * Cite: ../pi/packages/coding-agent/docs/session-format.md (id/parentId tree,
 * active leaf). Entries here are harness-owned; Chat.history rebuild from the
 * active path is a separate wiring step (worker / durable log).
 */
import { Schema as S } from "effect";

export const SessionEntryId = S.String;
export type SessionEntryId = typeof SessionEntryId.Type;

export const SessionEntry = S.Struct({
  id: SessionEntryId,
  parentId: S.optional(SessionEntryId),
  /** Opaque payload — user/assistant/tool/compaction/branch_summary live above. */
  kind: S.String,
  createdAt: S.Finite,
});
export type SessionEntry = typeof SessionEntry.Type;

export interface SessionTree {
  readonly entries: ReadonlyMap<SessionEntryId, SessionEntry>;
  /** Active leaf — the tip of the branch the next prompt extends. */
  readonly leaf: SessionEntryId | undefined;
}

export const emptySessionTree = (): SessionTree => ({
  entries: new Map(),
  leaf: undefined,
});

export const appendEntry = (tree: SessionTree, entry: SessionEntry): SessionTree => {
  const entries = new Map(tree.entries);
  entries.set(entry.id, entry);
  return { entries, leaf: entry.id };
};

/** Path from root to leaf (inclusive). Missing parents stop the walk. */
export const pathToLeaf = (
  tree: SessionTree,
  leaf: SessionEntryId | undefined = tree.leaf,
): readonly SessionEntry[] => {
  if (!leaf) return [];
  const path: SessionEntry[] = [];
  let current: SessionEntryId | undefined = leaf;
  const seen = new Set<SessionEntryId>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const entry = tree.entries.get(current);
    if (!entry) break;
    path.push(entry);
    current = entry.parentId;
  }
  return path.reverse();
};

/** Move the active leaf to an existing entry (Pi /tree navigation). */
export const checkout = (tree: SessionTree, entryId: SessionEntryId): SessionTree | undefined => {
  if (!tree.entries.has(entryId)) return undefined;
  return { entries: tree.entries, leaf: entryId };
};

/**
 * Fork: keep shared prefix entries, new leaf id for the branch tip.
 * Caller supplies the new entry (typically a user message copy).
 */
export const forkAt = (
  tree: SessionTree,
  fromId: SessionEntryId,
  next: SessionEntry,
): SessionTree | undefined => {
  if (!tree.entries.has(fromId)) return undefined;
  if (next.parentId !== fromId) return undefined;
  return appendEntry(tree, next);
};
