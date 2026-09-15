/**
 * Vim-style undo tree on persistent TextBuffer refs.
 *
 * Each node is a full document state. `u` walks to the parent; `Ctrl-R`
 * follows `preferChildId` (last undone child, or the newest edit). A new
 * edit after undo adds a sibling branch — older children stay reachable via
 * `g-` / `g+` (chronological seq order). Cite: vim undo-tree; SumTree
 * structural sharing makes per-node buffer storage O(1).
 */
import { toText } from "@danielfgray/amux-text-buffer";
import type { TextBuffer } from "@danielfgray/amux-text-buffer";
import { Option } from "effect";
import type { BufferSnapshot, Cursor, EditorState, UndoNode, UndoTree } from "./schema.ts";
import { clearPendingEdits, setBuffer } from "./buffer-state.ts";
import { atomFromRecording } from "./cmd-atom.ts";
import { pushChange } from "./jumps.ts";
import { press, type Key } from "./key.ts";

export const MAX_UNDO = 100;

export const snapshotOf = (state: EditorState): BufferSnapshot => ({
  buffer: state.buffer,
  cursor: { ...state.cursor },
});

/** Prefer identity (every edit replaces the buffer ref); fall back to text. */
export const buffersEqual = (a: TextBuffer, b: TextBuffer): boolean =>
  a === b || toText(a) === toText(b);

export function initialUndoTree(buffer: TextBuffer, cursor: Cursor): UndoTree {
  const root: UndoNode = {
    id: 0,
    buffer,
    cursor: { ...cursor },
    parentId: null,
    childIds: [],
    preferChildId: null,
    seq: 0,
  };
  return { nodes: { 0: root }, head: 0, nextId: 1, nextSeq: 1 };
}

/** Replace the buffer and re-root the undo tree (tests / :e loads). */
export function seedBuffer(state: EditorState, buffer: TextBuffer, cursor?: Cursor): EditorState {
  const nextCursor = cursor ?? { ...state.cursor };
  return {
    ...clearPendingEdits(state),
    buffer,
    cursor: nextCursor,
    // Fresh placement — next `j`/`k` should prefer this column.
    curswant: nextCursor.col,
    setCurswant: true,
    undoTree: initialUndoTree(buffer, nextCursor),
    changeBase: null,
    recording: null,
  };
}

/** Digits already typed as a count, expanded into recording keys. */
export const countKeys = (state: EditorState): Key[] =>
  state.count === "" ? [] : [...state.count].map((digit) => press(digit));

const withHeadCursor = (tree: UndoTree, cursor: Cursor): UndoTree => {
  const head = tree.nodes[tree.head];
  if (head === undefined) return tree;
  return {
    ...tree,
    nodes: {
      ...tree.nodes,
      [head.id]: { ...head, cursor: { ...cursor } },
    },
  };
};

/** Begin a change: freeze the buffer and start the `.` key tape. */
export function startChange(state: EditorState, keys: readonly Key[]): EditorState {
  if (state.changeBase !== null) {
    return {
      ...state,
      recording: [...(state.recording ?? []), ...keys],
      count: "",
    };
  }
  // Point the head node's cursor at the change origin so `u` lands there.
  return {
    ...state,
    undoTree: withHeadCursor(state.undoTree, state.cursor),
    changeBase: snapshotOf(state),
    recording: [...countKeys(state), ...keys],
    count: "",
  };
}

export function appendChangeKey(state: EditorState, key: Key): EditorState {
  if (state.recording === null) return state;
  return { ...state, recording: [...state.recording, key] };
}

export function cancelChange(state: EditorState): EditorState {
  return { ...state, changeBase: null, recording: null };
}

/**
 * Seal a change. Yank-only edits skip the tree. Content edits append a child
 * of the current head (a new branch if we had undone).
 */
export function finishChange(state: EditorState): EditorState {
  if (state.changeBase === null) {
    return { ...state, recording: null };
  }
  const contentChanged = !buffersEqual(state.changeBase.buffer, state.buffer);
  if (!contentChanged) {
    return { ...state, changeBase: null, recording: null };
  }
  // Cascade replay: keep the buffer mutation; primary already owns the undo node.
  if (state.cascading) {
    return { ...state, changeBase: null, recording: null, dirty: true };
  }
  const lastChange = state.repeating ? state.lastChange : { keys: state.recording ?? [] };
  const lastAtom = state.repeating
    ? state.lastAtom
    : atomFromRecording(state.recording ?? [], state.changeBase.cursor, true);
  const atomGeneration =
    state.repeating || lastAtom === state.lastAtom
      ? state.atomGeneration
      : state.atomGeneration + 1;
  return {
    ...commitNode(state),
    lastChange,
    lastAtom,
    atomGeneration,
    changeList: pushChange(state.changeList, state.cursor),
    changeBase: null,
    recording: null,
  };
}

function commitNode(state: EditorState): EditorState {
  const tree = state.undoTree;
  const parent = tree.nodes[tree.head];
  if (parent === undefined) return state;
  const id = tree.nextId;
  const child: UndoNode = {
    id,
    buffer: state.buffer,
    cursor: { ...state.cursor },
    parentId: parent.id,
    childIds: [],
    preferChildId: null,
    seq: tree.nextSeq,
  };
  const updatedParent: UndoNode = {
    ...parent,
    childIds: [...parent.childIds, id],
    preferChildId: id,
  };
  const nodes = {
    ...tree.nodes,
    [parent.id]: updatedParent,
    [id]: child,
  } satisfies Record<number, UndoNode>;
  const grown: UndoTree = {
    nodes,
    head: id,
    nextId: id + 1,
    nextSeq: tree.nextSeq + 1,
  };
  return { ...state, undoTree: pruneTree(grown) };
}

/** Drop oldest seq nodes that aren't ancestors of head, keeping ≤ MAX_UNDO. */
function pruneTree(tree: UndoTree): UndoTree {
  const ids = Object.keys(tree.nodes).map(Number);
  if (ids.length <= MAX_UNDO) return tree;

  const keep = new Set<number>();
  let walk: number | null = tree.head;
  while (walk !== null) {
    keep.add(walk);
    walk = tree.nodes[walk]?.parentId ?? null;
  }
  const bySeq = ids.map((id) => tree.nodes[id]!).sort((a, b) => b.seq - a.seq);
  for (const node of bySeq) {
    if (keep.size >= MAX_UNDO) break;
    keep.add(node.id);
  }

  const nodes: Record<number, UndoNode> = {};
  for (const id of keep) {
    const node = tree.nodes[id]!;
    nodes[id] = {
      ...node,
      childIds: node.childIds.filter((child) => keep.has(child)),
      preferChildId:
        node.preferChildId !== null && keep.has(node.preferChildId) ? node.preferChildId : null,
    };
  }
  return { ...tree, nodes };
}

const restoreNode = (state: EditorState, node: UndoNode, tree: UndoTree): EditorState => ({
  ...setBuffer(clearPendingEdits(state), node.buffer),
  cursor: { ...node.cursor },
  undoTree: tree,
  changeBase: null,
  recording: null,
  message: null,
});

/** `u` — walk to the parent (older state on this branch). */
export function undo(state: EditorState): EditorState {
  const tree = state.undoTree;
  const head = tree.nodes[tree.head];
  if (head === undefined || head.parentId === null) {
    return { ...state, message: "already at oldest change" };
  }
  const parent = tree.nodes[head.parentId];
  if (parent === undefined) return { ...state, message: "already at oldest change" };
  const updatedParent: UndoNode = { ...parent, preferChildId: head.id };
  return restoreNode(state, updatedParent, {
    ...tree,
    nodes: { ...tree.nodes, [parent.id]: updatedParent },
    head: parent.id,
  });
}

/** `Ctrl-R` — walk to the preferred child (redo / alternate branch tip). */
export function redo(state: EditorState): EditorState {
  const tree = state.undoTree;
  const head = tree.nodes[tree.head];
  if (head === undefined) return { ...state, message: "already at newest change" };
  const childId = head.preferChildId ?? head.childIds[head.childIds.length - 1] ?? null;
  if (childId === null) return { ...state, message: "already at newest change" };
  const child = tree.nodes[childId];
  if (child === undefined) return { ...state, message: "already at newest change" };
  return restoreNode(state, child, { ...tree, head: childId });
}

const nearestBySeq = (
  tree: UndoTree,
  current: UndoNode,
  prefer: "older" | "newer",
): Option.Option<UndoNode> =>
  Object.keys(tree.nodes).reduce((acc: Option.Option<UndoNode>, id) => {
    const node = tree.nodes[Number(id)]!;
    const eligible = prefer === "older" ? node.seq < current.seq : node.seq > current.seq;
    if (!eligible) return acc;
    return Option.match(acc, {
      onNone: () => Option.some(node),
      onSome: (best) =>
        prefer === "older"
          ? node.seq > best.seq
            ? Option.some(node)
            : acc
          : node.seq < best.seq
            ? Option.some(node)
            : acc,
    });
  }, Option.none());

/** `g-` — previous change in chronological seq order (may cross branches). */
export function undoOlder(state: EditorState): EditorState {
  const tree = state.undoTree;
  const current = tree.nodes[tree.head];
  if (current === undefined) return state;
  return Option.match(nearestBySeq(tree, current, "older"), {
    onNone: () => ({ ...state, message: "already at oldest change" }),
    onSome: (best) => restoreNode(state, best, { ...tree, head: best.id }),
  });
}

/** `g+` — next change in chronological seq order. */
export function undoNewer(state: EditorState): EditorState {
  const tree = state.undoTree;
  const current = tree.nodes[tree.head];
  if (current === undefined) return state;
  return Option.match(nearestBySeq(tree, current, "newer"), {
    onNone: () => ({ ...state, message: "already at newest change" }),
    onSome: (best) => restoreNode(state, best, { ...tree, head: best.id }),
  });
}
