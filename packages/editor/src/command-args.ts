/**
 * Editor command field Schemas and typed builders shared by the daemon
 * registration and the client UI. No reduce/run — those stay in daemon.ts.
 */
import { Schema as S } from "effect";
import { encodeRegisteredCommand } from "@danielfgray/amux";

export const EditorOpenArgs = S.Struct({
  file: S.optionalKey(S.String),
  split: S.optionalKey(S.Boolean),
});
export type EditorOpenArgs = typeof EditorOpenArgs.Type;
export const editorOpenCommand = encodeRegisteredCommand("editor.open", EditorOpenArgs);
