/**
 * Display-only strokes for mux showcmd. Operator / find / surround / map
 * grammar stays in vim-core; this formats what chrome should show alongside
 * the keymap pending sequence. Cite: neovim 'showcmd'.
 */
import type { EditorState, FindKind, OperatorPending, SurroundPending } from "./schema.ts";

const operatorChar = (pending: OperatorPending): string => {
  switch (pending.kind) {
    case "delete":
      return "d";
    case "change":
      return "c";
    case "yank":
      return "y";
  }
};

const findChar = (kind: FindKind): string => kind;

const surroundStrokes = (pending: SurroundPending): readonly string[] => {
  switch (pending.mode) {
    case "add":
      if (pending.phase === "motion") {
        return "textObject" in pending
          ? ["y", "s", pending.textObject === "inner" ? "i" : "a"]
          : ["y", "s"];
      }
      if (pending.phase === "char") return ["y", "s", "…"];
      return ["y", "s", "t", ...pending.name.split("")];
    case "delete":
      return ["d", "s"];
    case "change":
      if (pending.phase === "old") return ["c", "s"];
      if (pending.phase === "new") return ["c", "s", pending.old];
      return ["c", "s", "t", ...pending.name.split("")];
  }
};

/** Incomplete vim grammar for the tab-bar showcmd (not which-key). */
export function showcmdStrokes(state: EditorState): readonly string[] {
  const strokes: string[] = [];
  if (state.selectedRegister !== "") {
    strokes.push(`"${state.selectedRegister}`);
  }
  if (state.pendingRegister !== "") {
    strokes.push('"');
  }
  if (state.pending !== null) {
    // Count is folded into pending by armOperator (startChange clears state.count).
    if (state.pending.count > 1) strokes.push(String(state.pending.count));
    strokes.push(operatorChar(state.pending));
    if (state.pending.motionForce === "v") strokes.push("v");
    if (state.pending.motionForce === "V") strokes.push("V");
    if (state.pending.motionForce === "block") strokes.push("ctrl+v");
    if (state.pending.textObject === "inner") strokes.push("i");
    if (state.pending.textObject === "outer") strokes.push("a");
  } else if (state.count !== "") {
    strokes.push(state.count);
  }
  if (state.pendingCase !== null) {
    if (state.pendingCase.kind === "lower") strokes.push("g", "u");
    else if (state.pendingCase.kind === "upper") strokes.push("g", "U");
    else strokes.push("g", "~");
  }
  if (state.pendingEqual !== null) strokes.push("=");
  if (state.pendingIndent !== null) {
    strokes.push(state.pendingIndent.dir > 0 ? ">" : "<");
  }
  if (state.pendingReplace !== null) strokes.push("r");
  if (state.pendingFind !== null) strokes.push(findChar(state.pendingFind.kind));
  if (state.pendingMap.length > 0) strokes.push(...state.pendingMap);
  if (state.pendingSurround !== null) strokes.push(...surroundStrokes(state.pendingSurround));
  if (state.pendingMark) strokes.push("m");
  if (state.pendingJump !== null) strokes.push(state.pendingJump);
  if (state.pendingMacro) strokes.push("q");
  if (state.pendingAt) strokes.push("@");
  return strokes;
}
