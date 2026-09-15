/**
 * Pure vim engine — motions, reducer, key codec, structure interface, and the
 * builtin ex command table. No terminal UI kit, no highlight, no editor plugin.
 */

export {
  BUILTIN_COMMANDS,
  resolveCommand,
  type CommandComplete,
  type CommandNargs,
  type CommandRunArgs,
  type RegisteredCommand,
} from "./commands.ts";
export { KeySchema, KeyStruct, decodeKey, encodeKey, press, type Key } from "./key.ts";
export type {
  StructureGrammar,
  StructureNode,
  StructurePoint,
  StructureTree,
} from "./structure.ts";
export {
  applySurround,
  beginSearch,
  beginSubstitute,
  beginSurround,
  charFromKey,
  editorCommandItems,
  initialEditor,
  mapScopeOf,
  reduceEditor,
} from "./vim-core.ts";
export type { EditorEvent, EditorMode, EditorState } from "./schema.ts";
export { Phase } from "./schema.ts";
export { showcmdStrokes } from "./showcmd.ts";
export {
  BUILTIN_MAP_ENTRIES,
  isMapPrefixStroke,
  mapContinuationHints,
  pushMap,
  strokeFromKey,
  type BuiltinMapId,
  type MapEntry,
  type MapScope,
} from "./maps.ts";
export {
  bufferFromLines,
  editReplaceLines,
  lineAtRow,
  linesOf,
  rowCount,
  setBuffer,
  textOf,
} from "./buffer-state.ts";
export { finishChange, seedBuffer, startChange } from "./history.ts";
export { pushJump } from "./jumps.ts";
export { fitViewport } from "./vim-slices.ts";
export { withExtraCursors, type CmdAtom } from "./cmd-atom.ts";
export { findTagAt, tagDelimiters, tagTextObjectRange } from "./tags.ts";
export { addSurround, changeSurround, deleteSurround } from "./surround.ts";
