# Prior art: pluggable layout, chrome-slot negotiation, and tiling algorithms

Research for ep-e09db9 ("Pluggable layout: frame, chrome slots, and tiling algorithm"),
ticket ts-f511ae. Pure research — no amux design decisions are made here.

Three axes under investigation: (1) frame/chrome-slot arrangement, (2) conflict
resolution when two plugins want the same slot, (3) swappable tiling algorithm.

**Reading map:** the frame-arrangement and slot-conflict-negotiation tickets
need §1 (load-bearing) and can skip §2. The tiling-algorithm ticket needs §2's
Zellij/tmux/i3 entries (no tool anywhere makes the algorithm itself pluggable)
and can skip §1. Everyone should read §3.

---

## 1. Load-bearing prior art (read before designing frame-arrangement or slot-conflict-negotiation)

Two systems here are closer than anything external, for the same reason:
they're either already in amux's dependency tree or in a sibling codebase
using the identical plugin-host paradigm (Cordis) amux itself imitates.

### 1a. deepseek-harness's `ui-slots` — the closest real analogue

`../deepseek-harness`'s own UI chrome-slot system, `packages/client/ui-slots`
(`src/index.ts`, `src/store.ts`), consumed throughout `packages/client/ui-*`
(e.g. `ui-workspace/src/client/contract/slots.ts`,
`ui-settings-general/src/client/shell-contract.ts`), is a real, shipping
system solving both of this epic's hardest problems in one design — not
`vendor/cordis` (pure service dependency-injection, the mechanism amux itself
already imitates for `inject`/`provide`, and a *weaker* fit than this).

**Open-ended slots, declared not enumerated** — answers frame-arrangement.
There is no fixed `SlotMap` enum shipped by the framework — `interface
SlotMap {}` starts empty and every consumer package extends it via
TypeScript declaration merging (`declare module '@deepseek-ai/dsh-client-ui-slots'
{ interface SlotMap { 'sidebar.workspaces.directoryFlow': {...} } }`). More
importantly, **declaring a slot is a runtime act, not just a type**:
`register()`'s `children` option lets any registered entry declare new child
slot *names* at registration time (`SlotCore.register`,
ui-slots/src/index.ts:825-889) — "declaring is claiming": the registering
entry becomes the only entry allowed to author which further child keys exist
there, and a second attempt to declare an already-declared key throws naming
the first declarer. A plugin introduces a new slot kind by declaring it as a
child of a slot it already occupies — the frame's shape is a live declaration
tree, not a closed set the host enumerates up front.

**Real conflict resolution, not stacking or silent-drop** — answers
slot-conflict-negotiation. Every slot has a declared `kind`: `'single'`
(exactly one occupant), `'keyed'` (one occupant per literal key, e.g.
per-tab), `'list'` (many occupants, ordered, each independently removable —
the shape a status-bar's segments or a settings nav list wants), or `'chain'`
(ordered selector functions "elect" the first one whose pure `select(owner)`
returns non-null — genuine runtime routing, not static registration order).
Conflicts resolve by `priority`-based **shadowing**: entries sharing one cell
(the whole slot for `single`; same `key` for `keyed`; same `id` for `list`)
coexist at distinct priorities, sorted ascending, lowest wins — but a second
registration at an *already-occupied* priority (default 0) **throws, naming
the existing occupant and telling the caller to pick a different priority to
shadow it intentionally** (`SlotCore.register`, lines 796-824). Fail loud
rather than silently pick a winner, unlike opentui's `single_winner` (silent
drop, §1b) or VS Code's additive-stacking (no exclusivity at all, §2). No
separate claims/conflicts-with/replaces vocabulary needed on top of a DI
mechanism — the slot registry *is* the negotiation mechanism, and "register
at a lower priority" is the built-in deliberate-override path.

**Lifecycle matches Effect's Scope model amux already uses.** A slot's
disposer removes its contribution *and* cascades to collapse every child slot
that entry itself declared, recursively — "one lifecycle axis, no dangling
state" (docstring, lines 726-728) is the same guarantee Effect's `Scope`
teardown gives amux's plugin `effect`s. `register` returning a disposer maps
directly onto `Effect.addFinalizer`.

**Free diagnostics** — shrinks the discoverability ticket. `SlotCore.snapshot()`
exports the live declaration tree as JSON (`LiveSlotNode`: name, kind, scope,
declaredBy, occupants with priority/active, children) with zero extra design
work — an `amux plugin inspect` or a debug overlay showing "what's registered
where, and who's currently shadowed" falls out of the registry for free.

**What doesn't transfer directly:** `ui-slots` is React-specific (JSX
components, `ReactNode`, hooks-compartment binding) where amux is
Effect+SolidJS+opentui — the *data model* (kind taxonomy, declare-to-claim,
priority-shadowing-with-throw, scope axis, snapshot/inspection) is the
reusable part, not the implementation. `scope: 'root' | 'session-maybe' |
'session'` is keyed to deepseek-harness's own "session" concept and would
need remapping onto amux's window/space/server scoping (see CONTEXT.md) —
worth a design note on the frame-arrangement ticket, not a direct port.

### 1b. opentui's own slot registry — already in amux's dependency tree, unused

`@opentui/core` (amux's renderer) ships a generic plugin-slot system amux
does **not currently use** — `ui/App.tsx` hardcodes its chrome nesting
instead. `opencode` (a sibling AI-coding-agent TUI, also built on
`@opentui/solid`) has already built a real plugin system on top of it: a
working example of the shape amux's frame axis is reaching for, using the
exact runtime amux already depends on.

**opentui/core's slot registry** (`packages/core/src/plugins/{registry,core-slot}.ts`,
wrapped for Solid in `packages/solid/src/plugins/slot.tsx`): a `SlotRegistry`
holds `{id, order, setup, dispose, slots: {slotName: renderer}}` plugin
records. `resolveEntries(slotName)` returns every contributing plugin sorted
by `order` (ascending, default 0), then registration order, then id — always
a total order, never an error case. A `<Slot name="..." mode="append|
single_winner|replace">` component reads that list: `append` (default) stacks
every contributor after the fallback; `single_winner` renders only
`entries[0]`, silently dropping every other contributor — not notified, no
diagnostic; `replace` is `append` without the fallback mixed in. **This is
the bare "priority number" model, with no negotiation** — no claim/
conflicts-with/replaces declaration, no refusal, `order` is a plain integer
set once at registration. Ownership tracking (`host` vs `plugin` render
authority) governs *teardown* only, not conflict resolution.

opencode wraps this in `TuiPluginApi.slots.register()`, and its own built-in
sidebar panels (files, todo, lsp, mcp) are themselves registered as slot
contributions rather than hardcoded — the host's own chrome is "just another
plugin." But opencode inherits opentui's ordering-only resolution verbatim;
it adds no claims/conflicts model on top.

**Takeaway:** opentui's registry is a good primitive for the *rendering*
half of the frame axis (where a plugin's tree mounts, how contributors
compose) — Solid-reconciler integration for free — but its resolution policy
is the "worse than tmux" baseline this epic wants to exceed. If amux builds
on it, ui-slots' negotiation model (§1a: kind + priority-shadowing-with-throw)
has to sit on top, resolving conflicts before assigning `order`, not by
relying on `single_winner`'s silent pick.

---

## 2. Surveyed and ruled out: no external tool negotiates chrome, none makes tiling pluggable

Zellij, Neovim, VS Code, tmux, and i3/sway were surveyed for both axes. None
has a real claims/conflicts-with/replaces negotiation for contested chrome —
Neovim is silent last-write-wins, VS Code is pure additive stacking with a
priority int. And none lets a plugin replace the core tiling/packing
algorithm — every one caps plugin power at "manipulate panes within the
tree" or "swap in a whole pre-authored tree," never "supply a different
function from (tree, size) → geometry." If amux wants a genuinely swappable
*algorithm* (not swappable presets, not swappable trees), this is novel
ground — no production system below is a template for that specifically.

### Zellij — KDL layout files + plugin API

**Declarative config vs plugin:** layouts are static KDL files describing a
tree of tabs/panes. A layout can declare **swap layouts** — named alternate
arrangements (`swap_tiled_layout`, `swap_floating_layout`) the user cycles
through with a keybinding, typically keyed by pane-count breakpoints. The
*set* of candidate arrangements is authored in the KDL file, not computed by
a plugin. Real plugins (WASM, `zellij-tile` SDK) get a permissioned command
surface (`move_pane*`, `resize_*`, `stack_panes`, `float_multiple_panes`,
`break_panes_to_*`) plus `override_layout`/`new_tabs_with_layout`, which
apply a whole new KDL layout at runtime, including as an overlay onto a
running session.

**Tiling algorithm pluggable?** No — every command manipulates panes within
the existing tree or swaps in a pre-authored tree; the box-splitting math is
Rust core.

**Conflict resolution:** N/A — a layout is authored/composed by one driving
plugin/user at a time, not contributed by independent competitors.

**Worth stealing:** the swap-layout concept (a named, declarative set of
candidate arrangements, switchable by condition) maps well onto amux wanting
config-selected, swappable tiling without necessarily making the *algorithm*
itself a plugin API on day one. `override_layout`'s "apply a whole new tree,
retain what still fits" is a clean model for hot-swapping without restarting.

**Avoid:** the ad hoc command list assumes one driving plugin at a time — it
has no declared ownership over regions, which won't hold for amux's goal of
multiple independent chrome contributors.

Sources: https://zellij.dev/documentation/layouts.html,
https://zellij.dev/documentation/plugin-api-commands.html,
https://zellij.dev/documentation/plugin-api-permissions.html,
https://github.com/zellij-org/zellij/issues/4663

### Neovim — windows, floats, and statusline/sidebar plugins — the cautionary tale

The window model (split tree, `vsplit`/`split`) is core, not pluggable at
the algorithm level; floating windows are a first-class core primitive
(arbitrary z-ordered overlay, no tree slot), which is why plugins can build
sidebars/popups/floating statuslines at all.

**Coexistence mechanism: none.** Sidebar plugins (nvim-tree, neo-tree) each
open their own edge-pinned split — two sidebar plugins claiming the left
edge produce two splits, not a negotiated one. Statusline/bufferline plugins
(lualine and its many alternatives) overwrite the global `&statusline`/
`&winbar`/`&tabline` option string on autocmds — "whoever's autocmd ran last
wins," with "disable the other plugin in your config" as the documented
remedy. `laststatus=3` (one global bar) makes this worse: now there's only
one bar for N plugins to fight over. No ownership or exclusivity primitive
anywhere in this stack.

**Worth stealing:** the float-vs-tiled split itself — an explicit "not in
the tree" placement mode alongside "in the tree" is a useful vocabulary for
amux's slot/frame design (a plugin surface that's positioned but doesn't
participate in tiling math).

**Explicitly avoid:** "last write to a shared global wins," and "tell the
user to disable the other plugin" as the support answer — direct examples of
what this epic's negotiation mechanism (§1a) is meant to prevent.

Sources: https://github.com/neovim/neovim/issues/16753,
https://neovimcraft.com/plugin/b0o/incline.nvim/,
https://github.com/nvim-lualine/lualine.nvim

### VS Code — workbench contribution points

**Pluggable:** `contributes.viewsContainers` adds a container to the
Activity Bar or Panel; `contributes.views` adds views into any container;
`contributes.statusBarItems` adds status bar items with a numeric `priority`
for ordering. All declared in `package.json` plus a runtime API.

**Conflict/ownership: none — pure additive stacking.** Multiple extensions
contributing to the same container, or the same status bar alignment, just
all render. Ordering is a fixed precedence tier for welcome-content text
(core, then built-in extensions, then everyone else) or a numeric priority
for status bar items — same "biggest number wins position" flavor as
opentui's `order`. No exclusion, no declared "conflicts with," no
arbitration; the user's only lever is manual drag-and-drop afterward. VS
Code treats "too many contributors" as a UI/discoverability problem, not an
extension-authoring-time one.

**Worth stealing:** the id-addressable container as a stable extension point
many extensions can *target* without owning — good for "shared slot, many
additive fillers" cases (amux's status bar segments plausibly want this).
Numeric-priority-plus-user-can-rearrange is a reasonable *fallback* when no
plugin declares a real conflict.

**Avoid:** treating "let the user drag it around afterward" as sufficient
for cases where two plugins **structurally cannot** coexist (two plugins
that both want to *be* the primary sidebar, not just add a view into it) —
VS Code never hits this because its containers are cheap and stackable;
amux's fixed-anchor chrome slots don't have that luxury.

Sources: https://code.visualstudio.com/api/references/contribution-points,
https://code.visualstudio.com/api/extension-capabilities/extending-workbench,
https://code.visualstudio.com/api/ux-guidelines/views

### tmux — layout strings / `select-layout` (non-pluggable baseline)

Five fixed named presets (`even-horizontal`, `even-vertical`,
`main-horizontal`, `main-vertical`, `tiled`), each a hardcoded algorithm in
C. `select-layout -E` re-evens proportions; a saved layout string records
literal cell geometry, not a re-runnable algorithm — it doesn't reflow if
pane count changes, it just fails to fit. No plugin hook exists to add a
sixth algorithm. This confirms amux's `layout.ts` today (fixed
`splitLayout`/`presetLayout`/`tiled()`, the same five preset names) is at
tmux parity, not below it: amux's "globally config-selected, swappable
algorithm" goal is already a step past tmux (config picks *which* fixed
preset), and the epic's ambition — pluggable algorithm implementations, not
just preset selection — goes further than any tool here.

Sources: https://www.mintlify.com/tmux/tmux/advanced/layouts,
https://tao-of-tmux.readthedocs.io/en/stable/manuscript/06-window.html

### i3/sway — container tree (fixed-but-rich split model)

Every container has an orientation and mode: plain split (`splith`/
`splitv`), `tabbed`, or `stacking`; the tree is recursive (richer nesting
than tmux's flat five-preset model) but entirely fixed/core — no plugin
surface for the tree algorithm. The one notable "plugin," `autotiling`,
doesn't add an algorithm either — it watches window dimensions and issues
`layout splith`/`layout splitv` to switch which *existing* fixed mode is
active: a policy script driving built-in modes, the same ceiling as
tmux/Zellij.

**Worth stealing:** the recursive container tree as a richer *data
structure* for describing arrangements — if amux's tiling axis wants "more
expressive than 5 presets" as an interim step before full pluggability,
i3's tree-of-{split,tabbed,stacked} nodes is a proven target shape.

Sources: https://i3wm.org/docs/userguide.html,
https://pypi.org/project/autotiling

---

## 3. Recommendation for the design session

- **Frame arrangement**: model slot declaration on ui-slots' declare-to-claim
  (§1a) — a plugin declares new child slots as part of occupying a slot it
  already has, rather than the host enumerating a fixed set. Decide whether
  amux builds this on top of opentui's `SlotRegistry` (§1b — Solid-reconciler
  integration for free, but its ordering-only resolution must be replaced,
  not inherited) or as a bespoke registry.
- **Slot-conflict negotiation**: adopt ui-slots' kind taxonomy
  (single/keyed/list/chain) plus priority-shadowing-with-throw-on-collision
  (§1a) as the mechanism itself, not a claims/conflicts-with/replaces
  vocabulary layered over the existing Cordis service-DI resolution — the
  slot registry *is* the negotiation, and it's a closer fit than extending
  `inject`/`provide` from services to UI regions would be.
  `SlotCore.snapshot()`'s live declaration tree is a template for the
  discoverability ticket's inspection tooling at near-zero extra design cost.
- **Tiling algorithm**: no tool surveyed (§2) makes the algorithm itself
  pluggable — treat that as the genuinely novel part of this epic. Zellij's
  swap-layout concept and i3's recursive container tree are the two ideas
  worth borrowing as intermediate steps or richer data shapes, not full
  answers.
