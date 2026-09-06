# A tiling algorithm's materialization output is always tree-shaped; only its internal/persisted state is opaque

ADR 0002 said a tiling algorithm's "output and persisted state are opaque and
plugin-owned... not required to be a `LayoutNode` tree — required for
niri-style scrolling-column tiling, which has no tree at all." Building the
pane-host slot's actual interface (this ADR's effort) against a real second
algorithm — a niri-style horizontal scrolling-column layout, not a
hypothetical — surfaced that this claim doesn't survive contact with how
`Window` actually renders.

`Window#mount()` materializes a layout into opentui `BoxRenderable`/`Divider`
nodes; opentui's own renderable graph is a tree (Yoga-backed flexbox). There
is no way to hand `#mount()` something that isn't tree-shaped and have it
render, because the thing being rendered — boxes nested inside boxes on a
screen — is inherently a tree regardless of which algorithm arranged it.
Geometry queries (`focusInDirection`, `resizeFocus`, divider-neighbor checks)
are similarly walking a tree today; they are not blocked by *some* tree
existing, they are blocked by assuming one *specific* tree shape (binary/n-ary
splits with sibling-relative weights).

Investigating niri's actual model confirmed the tree assumption itself was
never the problem: an infinite horizontal strip of columns, each a vertical
stack of panes, with a scroll offset determining which columns are visible —
rendered at any instant, this is still a box nested inside a clipped
viewport box, i.e. still a tree. What niri's model doesn't fit is
`LayoutSplit`'s specific semantics: children sized by weight relative to
siblings inside a fixed container, rather than by an intrinsic size along a
scrollable axis whose total content can exceed the viewport.

**Decided:**

- `LayoutNode` gains a third variant, `LayoutScroll`, alongside `LayoutPane`
  and `LayoutSplit` (see `layout.ts`). Its children are `LayoutScrollItem`s —
  each carries an explicit `size` (cells along the scroll axis) rather than a
  `weight`, since weight only means something inside a fixed-size flex
  container. A niri-style algorithm's columns are `LayoutScrollItem`s whose
  `node` is itself a normal `LayoutSplit` (a column's own vertical pane
  stack) — ordinary weight-based sizing still governs everything *inside* a
  column.
- Materialization (`Window#mount()`) renders `LayoutScroll` as opentui's
  standard clip-plus-absolute-offset pattern: a viewport `Box` with
  `overflow: "hidden"`, holding a content `Box` positioned absolutely at
  `left/top: -offset`, whose own size is the sum of its children's `size`
  along the scroll axis. This is a real, existing opentui capability
  (`overflow`, `position: "absolute"` with negative offsets) — no new
  rendering primitive is needed.
- **What stays opaque** (per ADR 0002, unchanged): an algorithm's *internal
  decision state* — whatever it privately tracks to decide arrangement
  between operations — and its *persisted* representation in session.json
  (`ts-4feabe`'s `{algorithmId, algorithmVersion, blob}` triple, still
  deferred). Nothing about `LayoutScroll` requires an algorithm to persist or
  internally represent state as a tree; it only requires the algorithm to be
  able to *produce* one, on demand, as its materialization output.
- **What is not generalized**: `geometry.ts`'s existing functions
  (`paneInDirection`, `resizePane`, `resizeDivider`, `dividerHasNeighbour`,
  `dividerTouchesPane`) remain specific to split/pane trees. A `LayoutScroll`
  node opts an algorithm out of these — a scroll-based algorithm supplies its
  own geometry-query implementations (moving focus across columns, bringing a
  newly-focused column into view by adjusting `offset`) rather than reusing
  core's split-tree geometry, per `TilingAlgorithm`'s optional-operation
  design (`tiling-algorithm.ts`): only `close` and `focusInDirection` are
  required of every algorithm: everything else — split, swap, preset,
  resize — is an optional capability an algorithm may omit, and Window
  hides or no-ops the corresponding command when it's absent rather than
  assuming universal support.

**Considered:** generalizing `LayoutSplit` itself (a `sizing: "weight" |
"absolute"` mode per child) instead of adding a new node kind — rejected
because it would make every existing consumer of `LayoutSplit` (which assumes
uniform weight-based children) handle a case it never actually needs, for the
sake of a distinction (weight vs. scroll-intrinsic-size) that only ever
matters together with an unbounded, offset-scrolled container. A dedicated
`LayoutScroll` node keeps that complexity local to the one place it's real.

**Consequences:**

- `Window`'s transform methods (split, close, swap, resize, focus-move,
  preset-cycle) no longer call `layout.ts`'s free functions directly — they
  delegate to the pane-host slot's elected `TilingAlgorithm`, which may or
  may not support a given operation.
- Today's split/weight/preset logic (`splitLayout`, `presetLayout`, `tiled`,
  `swapLayout`, `closeLayout`) becomes the *default* `TilingAlgorithm`,
  wrapping the exact same `Layout`/`LayoutNode` shapes it always has — no
  behavior change for the only algorithm that exists today.
- A niri-style algorithm is a second, real `TilingAlgorithm` built alongside
  the default one specifically to validate this contract against something
  structurally different, not left as an unbuilt hypothetical.
