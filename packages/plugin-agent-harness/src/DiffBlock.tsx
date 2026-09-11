/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree; OpenTUI DiffRenderable owns layout. */
/**
 * Shared OpenTUI `<diff>` for tool results and permission approvals.
 *
 * Cite: opencode `Edit` / `EditBody` — responsive unified↔split at 120 cols,
 * filetype + SyntaxStyle for tree-sitter colors on top of add/remove wash.
 */
import { createMemo, type Accessor } from "solid-js";
import { theme } from "@danielfgray/amux";
import { codeSyntaxStyle, filetypeForPath } from "@danielfgray/amux-highlight";
import { DIFF_SPLIT_MIN_WIDTH, pathFromUnifiedDiff } from "./diff-view.ts";

export function DiffBlock(props: {
  diff: string;
  /** Overrides the path parsed from the `+++` header when known. */
  path?: string;
  width: number | Accessor<number>;
}) {
  const width = () => (typeof props.width === "function" ? props.width() : props.width);
  const view = createMemo(() => (width() > DIFF_SPLIT_MIN_WIDTH ? "split" : "unified"));
  const path = createMemo(() => props.path ?? pathFromUnifiedDiff(props.diff));
  const filetype = createMemo(() => {
    const file = path();
    return file === undefined ? undefined : filetypeForPath(file);
  });

  return (
    <box style={{ width: "100%", flexShrink: 0, marginTop: 1, paddingLeft: 1 }}>
      <diff
        diff={props.diff}
        view={view()}
        filetype={filetype()}
        syntaxStyle={codeSyntaxStyle()}
        showLineNumbers={true}
        width="100%"
        wrapMode="word"
        fg={theme.text}
        addedBg={theme.diffAddedBg}
        removedBg={theme.diffRemovedBg}
        contextBg={theme.diffContextBg}
        addedSignColor={theme.diffHighlightAdded}
        removedSignColor={theme.diffHighlightRemoved}
        lineNumberFg={theme.diffLineNumber}
        lineNumberBg={theme.diffContextBg}
        addedLineNumberBg={theme.diffAddedLineNumberBg}
        removedLineNumberBg={theme.diffRemovedLineNumberBg}
      />
    </box>
  );
}
