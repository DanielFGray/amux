/**
 * Structure query surface the engine needs for tag textobjects and surround.
 * Highlight's parsers return StructureGrammar; the engine never imports highlight.
 */

export type StructurePoint = {
  readonly row: number;
  /** UTF-16 code unit column, matching the editor cursor. */
  readonly col: number;
};

export type StructureNode = {
  /**
   * Tree-sitter node id — unique within one tree. Equal nodes (same
   * underlying node reached via different wrappers) share this id.
   */
  readonly id: number;
  readonly type: string;
  readonly start: StructurePoint;
  readonly end: StructurePoint;
  readonly text: string;
  readonly childCount: number;
  child: (index: number) => StructureNode | null;
  namedChild: (index: number) => StructureNode | null;
  parent: () => StructureNode | null;
  /** Walk this node then parents, innermost first. */
  ancestors: () => Iterable<StructureNode>;
};

export type StructureTree = {
  readonly content: string;
  /** Program / document root. Valid until `delete()`. */
  readonly root: StructureNode;
  readonly nodeAt: (row: number, col: number) => StructureNode | null;
  /** Free the underlying wasm tree. Safe to call once. */
  readonly delete: () => void;
};

/** Loaded grammar: sync parse for the keypress path. */
export type StructureGrammar = {
  readonly name: string;
  readonly parse: (content: string) => StructureTree | null;
};
