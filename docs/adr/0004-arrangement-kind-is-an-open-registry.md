# A container node's arrangement kind is an open, plugin-registered fact, not a closed union member

Supersedes docs/adr/0003-tiling-materialization-is-tree-shaped.md's `LayoutNode`
shape (`LayoutPane | LayoutSplit | LayoutScroll`). ADR 0003's reasoning about
*why* materialization must be tree-shaped still holds unchanged; only the
"how many named tree shapes does core define" answer changes.

**The problem ADR 0003 didn't see:** amux's whole point is to be maximally
extensible via plugins, not to encode every feature decision itself. A closed
union — even a three-member one — means core must have prescience about every
arrangement a plugin will ever invent. `LayoutScroll` existing in `layout.ts`
at all is evidence of the failure mode: it was added because *one* plugin
(niri-style scrolling columns) needed it, and a second plugin with a fourth
shape (a grid, tabs, anything) would force the same edit to core again.

**Decided:**

- `LayoutNode` becomes `LayoutPane | LayoutSplit | LayoutContainer`.
  `LayoutContainer` is generic: `{ type: "container", kind: string, weight:
  number, children: readonly LayoutNode[], arrangement: unknown }`. `kind`
  names which registered arrangement this is; `arrangement` is an opaque,
  JSON-shaped payload only the owning plugin interprets — core never reads
  into it. `children` is a **plain** `LayoutNode[]`, not a wrapped/annotated
  array: any per-child metadata a kind needs (niri's per-column `size`, for
  example) lives inside `arrangement`, keyed by child position, not on the
  child slot itself. This is what lets core's generic traversal
  (`layoutPanes`, node-count/depth budgets, `reservePaneId`, `collapse`)
  recurse through *any* container kind by just walking `children` — it never
  needs to know what `arrangement` means.
- `LayoutSplit` stays a named, first-class arm (not folded into
  `LayoutContainer`) because core's own default algorithm and
  `geometry.ts`'s real structural logic (weight-based sizing, divider paths,
  neighbour checks) depend on its specific shape, not just "some container."
  Nothing else gets that treatment going forward — a second built-in-feeling
  need doesn't earn a fourth union member, it earns a `kind` registration
  like anyone else's (see below on "split"/"scroll" symmetry).
- `LayoutScroll`/`LayoutScrollItem` are deleted from `layout.ts` entirely and
  move into `plugin-niri`, the one thing that ever needed them. Concretely:
  `plugin-niri` registers `kind: "scroll"` and owns the arrangement shape
  (offset + per-column sizes, now living in the container's `arrangement`
  field rather than on each child) as its own private type. Core's `layout.ts`
  no longer mentions scrolling, viewports, or offsets anywhere.
- A `kind` carries two independent registrations, not one bundled object,
  because they run in different processes: an **arrangement schema**
  (`Effect.Schema` for `arrangement`'s shape) registered from the plugin's
  `"./daemon"` entrypoint — decoding/persistence is daemon-side — and a
  **renderer** (turns `arrangement` + already-materialized child renderables
  into opentui boxes) registered from the plugin's `"."` (UI) entrypoint,
  as a new keyed slot in `ui/slots.ts` alongside the existing chrome-slot
  registrations. `TilingAlgorithmsTag` (ADR 0002's election registry) stays
  untouched and separate: an algorithm and a kind are **many-to-many** —
  niri's own tree mixes `kind: "scroll"` at the root with plain `LayoutSplit`
  nodes for each column's internal stack, and any future algorithm can reuse
  "split" the same way.
- "Fully dogfooded, no fast path" applies to every node that actually *is* a
  `LayoutContainer` — `"scroll"` included, which plugin-niri registers exactly
  like a third party would. `LayoutSplit` is not a `LayoutContainer` at all
  (it has no `kind`, no opaque `arrangement`): it is the other named arm of
  `LayoutNode`, so there is nothing of its to register. `window.ts`'s
  `build()` keeps its existing `node.type === "split"` case as a real
  TypeScript-narrowed branch, unrelated to the kind registry, which only ever
  gets consulted for `node.type === "container"`. This is not a fast path for
  a kind that could have gone through the registry — "split" was never a
  registrable kind to begin with.
- Kind-name collisions throw at registration time, naming the earlier owner
  — the same "declaring is claiming" rule `ui/slots.ts` already enforces for
  chrome slots. No forced namespace/prefix convention.
- Decode-time validation is two-phase. `LayoutNodeSchema` only checks the
  generic envelope (`type`, `kind: string`, `children`, `weight`); a second
  pass looks up the registered schema for that `kind` and decodes
  `arrangement` through it, so a malformed niri arrangement fails with
  niri's own validation error rather than silently passing as "some JSON."
  Overall payload size stays bounded by the existing whole-layout
  `MAX_LAYOUT_BYTES` cap `decodeLayout` already enforces — no new per-node
  bound needed, matching `PaneContentSchema`'s existing plugin-descriptor
  precedent.
- A container whose `kind` has no registered schema (its plugin is disabled
  or uninstalled since the layout was saved) is **not** a decode failure: it
  passes through with `arrangement` left unvalidated, the same way a plugin
  simply not implementing a requested host variant is loader.ts's ordinary
  case, not a refusal. It also has no renderer, so materialization falls back
  the same way any other missing-capability case does — the session survives
  temporarily losing a layout plugin rather than becoming unloadable.

**Consequences:**

- `plugin-niri`'s per-column `size` moves from `LayoutScrollItem.size` (one
  per child, on the child wrapper) into the container's own `arrangement`
  blob (an offset plus a size list/map keyed by child position). This is a
  real shape change to niri's data, not just a rename — `LayoutScrollItem`
  is deleted, its `node`/`size` split across `children[i]` and
  `arrangement`.
- `geometry.ts`'s existing `node.type === "scroll"` bail-outs (it never read
  scroll's fields, only used the check to stop before applying split-tree
  math to something that isn't one) become `node.type === "container"`
  bail-outs — no semantic change, since that code was already kind-agnostic
  in practice.
- `Window#mount()`'s switch on `node.type` gains a `"container"` case that
  looks up the kind's registered renderer instead of a hardcoded `buildScroll`
  branch.
