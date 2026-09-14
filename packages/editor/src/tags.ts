/**
 * HTML/JSX tag locations via in-process tree-sitter.
 *
 * Maps grammar nodes (`jsx_element` / `element`) to the same open/close
 * spans surround.ts already edits. Callers pass a loaded Grammar — none
 * means findTagAt stays a no-op (grammar still loading or unavailable).
 */
import { Match, Option } from "effect";
import { type Grammar, type StructureNode } from "@danielfgray/amux-highlight";
import type { Cursor } from "./schema.ts";
import type { MotionRange } from "./motions.ts";

export type TagMatch = {
  readonly openPos: Cursor;
  readonly closePos: Cursor;
  readonly open: string;
  readonly close: string;
  readonly name: string;
  readonly selfClosing: boolean;
  /** Content between tags; equals open end for self-closing (empty). */
  readonly inner: MotionRange;
  /** Whole element including tags. */
  readonly outer: MotionRange;
};

const JSX_ELEMENT = "jsx_element";
const JSX_SELF = "jsx_self_closing_element";
const JSX_OPEN = "jsx_opening_element";
const JSX_CLOSE = "jsx_closing_element";
const HTML_ELEMENT = "element";
const HTML_START = "start_tag";
const HTML_END = "end_tag";
const HTML_SELF = "self_closing_tag";

const tagNameOf = (tagNode: StructureNode): string => {
  for (let i = 0; i < tagNode.childCount; i++) {
    const child = tagNode.child(i);
    if (child === null) continue;
    if (
      child.type === "identifier" ||
      child.type === "nested_identifier" ||
      child.type === "jsx_identifier" ||
      child.type === "tag_name" ||
      child.type === "member_expression"
    ) {
      return child.text;
    }
  }
  const m = /^<\/?\s*([^\s/>]+)/.exec(tagNode.text);
  return m?.[1] ?? "";
};

const asMatch = (open: StructureNode, close: Option.Option<StructureNode>): TagMatch => {
  const name = tagNameOf(open);
  return Option.match(close, {
    onNone: () => ({
      openPos: open.start,
      closePos: open.end,
      open: open.text,
      close: "",
      name,
      selfClosing: true,
      inner: { from: open.end, to: open.end, linewise: false, inclusive: false },
      outer: { from: open.start, to: open.end, linewise: false, inclusive: false },
    }),
    onSome: (closeNode) => ({
      openPos: open.start,
      closePos: closeNode.start,
      open: open.text,
      close: closeNode.text,
      name,
      selfClosing: false,
      inner: { from: open.end, to: closeNode.start, linewise: false, inclusive: false },
      outer: { from: open.start, to: closeNode.end, linewise: false, inclusive: false },
    }),
  });
};

/** Child walk: self-closing wins; otherwise open required, close optional. */
type ElementParts =
  | { readonly _tag: "none" }
  | { readonly _tag: "self"; readonly node: StructureNode }
  | {
      readonly _tag: "pair";
      readonly open: StructureNode;
      readonly close: Option.Option<StructureNode>;
    };

const scanElementChildren = (
  node: StructureNode,
  openType: string,
  closeType: string,
  selfType: string,
): ElementParts => {
  let open: StructureNode | null = null;
  let close: StructureNode | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child === null) continue;
    if (child.type === selfType) return { _tag: "self", node: child };
    if (child.type === openType) open = child;
    if (child.type === closeType) close = child;
  }
  if (open === null) return { _tag: "none" };
  return {
    _tag: "pair",
    open,
    close: close === null ? Option.none() : Option.some(close),
  };
};

const matchFromParts = (parts: ElementParts): Option.Option<TagMatch> =>
  Match.valueTags(parts, {
    none: () => Option.none(),
    self: ({ node }) => Option.some(asMatch(node, Option.none())),
    pair: ({ open, close }) => Option.some(asMatch(open, close)),
  });

const matchFromElement = (node: StructureNode): Option.Option<TagMatch> =>
  Match.value(node.type).pipe(
    Match.whenOr(JSX_SELF, HTML_SELF, () => Option.some(asMatch(node, Option.none()))),
    Match.when(JSX_ELEMENT, () =>
      matchFromParts(scanElementChildren(node, JSX_OPEN, JSX_CLOSE, JSX_SELF)),
    ),
    Match.when(HTML_ELEMENT, () =>
      matchFromParts(scanElementChildren(node, HTML_START, HTML_END, HTML_SELF)),
    ),
    Match.orElse(() => Option.none()),
  );

const isElementType = (type: string): boolean =>
  type === JSX_ELEMENT || type === JSX_SELF || type === HTML_ELEMENT || type === HTML_SELF;

/**
 * Innermost HTML/JSX element containing the cursor.
 * None when no grammar is loaded or no element wraps the point.
 */
export function findTagAt(
  lines: readonly string[],
  cursor: Cursor,
  grammar: Option.Option<Grammar>,
): Option.Option<TagMatch> {
  return Option.flatMap(grammar, (g) => {
    const content = lines.join("\n");
    const tree = g.parse(content);
    if (tree === null) return Option.none();
    try {
      const node = tree.nodeAt(cursor.row, cursor.col);
      if (node === null) return Option.none();
      for (const ancestor of node.ancestors()) {
        if (!isElementType(ancestor.type)) continue;
        const match = matchFromElement(ancestor);
        if (Option.isSome(match)) return match;
      }
      return Option.none();
    } finally {
      tree.delete();
    }
  });
}

/** tpope-style tag delimiters from the typed prompt (text before `>`). */
export function tagDelimiters(input: string): Option.Option<{ open: string; close: string }> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return Option.none();
  // Allow pasting a full open tag; strip surrounding < > if present.
  const body = trimmed.replace(/^</, "").replace(/>$/, "").trim();
  if (body.length === 0) return Option.none();
  const name = body.split(/\s+/)[0];
  if (name === undefined || name.length === 0) return Option.none();
  return Option.some({ open: `<${body}>`, close: `</${name}>` });
}

/** Inner/outer motion range for `it` / `at`. Self-closing: `it` none, `at` outer. */
export function tagTextObjectRange(
  lines: readonly string[],
  cursor: Cursor,
  grammar: Option.Option<Grammar>,
  inner: boolean,
): Option.Option<MotionRange> {
  return Option.flatMap(findTagAt(lines, cursor, grammar), (match) => {
    if (inner) {
      if (match.selfClosing) return Option.none();
      if (
        match.inner.from.row === match.inner.to.row &&
        match.inner.from.col === match.inner.to.col
      ) {
        return Option.none();
      }
      return Option.some(match.inner);
    }
    return Option.some(match.outer);
  });
}
