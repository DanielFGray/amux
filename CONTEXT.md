# amux

A terminal multiplexer (panes, windows, sessions, attach/detach) with an Effect-TS plugin architecture. Core knows nothing about what runs inside a pane; agent-aware behavior (recognizing coding agents, reading their state, driving their turns) is policy that lives in plugins, not core.

The plugin host follows the Cordis "context paradigm" (Shi, Zhang, Cui, "A Programming Paradigm for Spatiotemporal Composability"): `inject`/`provide` `Context.Tag`s are reactive coeffects (a plugin activates only when every dependency is satisfied, deactivates cleanly when one goes away); Effect's `Scope`-based teardown is the revertible-effect half (every side effect a plugin's `effect` performs is undone on removal, not just on shutdown). `plugin/loader.ts` + `plugin/hot.ts` are this model's declarative-configuration + hot-module-replacement component loader. Koishi, the paper's real-world case study, validates using npm-style semver ranges (`engines.<host>`) as the dependency-compatibility gate — the same mechanism amux's `engines.amux` compat check uses.

## Language

**Plugin**:
A `PluginDefinition` (`plugin/types.ts`): an id, the services it `inject`s and `provide`s, and an `effect` that runs once every injected tag is satisfied. Compatibility is declared by the published package (`engines.amux`), not the module. Plugin injection is all-or-nothing — a plugin missing one dependency is refused entirely, never partially activated.
_Avoid_: extension, addon

**Builtin plugin**:
The eliminated model: a plugin whose package was a workspace dependency of `amux` itself, statically imported in `plugin/loader.ts`'s `BUILTIN_PLUGINS` map so a compiled binary embedded its code, and referenced in config by a `builtin:<id>` path. Replaced by the _installed plugin_ — the `builtin:` spec form is gone, not aliased.
_Avoid_: bundled plugin, first-party plugin (see below — first-party is about authorship, builtin was about how it shipped)

**Installed plugin**:
A plugin whose npm package has been fetched into amux's own plugin store on disk, independent of whether it is currently active. The replacement for "builtin": nothing is embedded in the binary at compile time: every plugin, first-party or third-party, is installed the same way.
_Avoid_: registered plugin

**Active plugin**:
An installed plugin listed in config's `plugins` array with `enabled: true` — actually loaded into the running plugin host this session. An installed plugin need not be active.
_Avoid_: enabled plugin (fine as an adjective, but "active" is the noun-phrase term for this state)

**Plugin store**:
The on-disk location amux manages for installed plugins — separate from the user's own global npm/node_modules, so an installed plugin's own dependencies resolve normally without polluting or being polluted by anything else on the machine.
_Avoid_: plugin cache, plugin directory

**Plugin spec**:
One entry in config's `plugins` array, naming a plugin and whether it's active: a bare string or `{path, enabled}` for a plugin file, or `{package, version?, enabled}` for an npm package in the plugin store.
_Avoid_: plugin entry, plugin reference

**First-party plugin**:
A plugin published under the amux project's own ownership (today: agent-awareness, agent-harness, notifications, sidebar). Distinguishes authorship, not installation method — a first-party plugin is installed exactly like a third-party one.
_Avoid_: official plugin, core plugin

**Third-party plugin**:
Any plugin not published by the amux project itself.
_Avoid_: community plugin, external plugin

**Discovery keyword**:
The npm `keywords` field value (`amux-plugin`) a plugin package tags itself with, so a future `amux plugin search` can find candidates by npm registry search rather than by name pattern. Not a naming convention — a plugin's package name is unconstrained.
_Avoid_: naming convention, plugin prefix

**Slot** *(supersedes "chrome slot"; ui/regions.tsx's `Region` + `Anchor` pair, generalized)*:
A declared placement, keyed by name, that a plugin registers an occupant into. Modeled on deepseek-harness's `ui-slots`: a slot has a `kind` (`single` — exactly one occupant; `keyed` — one per literal key; `list` — many, ordered; `chain` — ordered selectors elect one at render time) and resolves a same-priority collision by throwing rather than silently stacking or dropping. A slot is declared by an occupant of some other slot ("declaring is claiming"); the **root slot** is the one a-priori exception, seeded by the host itself rather than declared by a plugin. Slots are never persisted — the running declaration tree exists only for the session.
_Avoid_: chrome slot, dock, region — "chrome slot" wrongly implied only non-pane content could occupy one (see **pane occupant** below); "dock"/"region" are the code-level names for the side, not the concept a plugin claims.

**Slot occupant**:
One registration into a slot. Two flavors distinguished by content, not by mechanism — both register the same way: a **chrome occupant** is plugin UI (what a sidebar or status-bar plugin registers); a **pane occupant** is a real pane, placed against a slot instead of sized against siblings in the tiled split tree.

**Pinned pane** *(a pane occupant of a `list`-kind slot; was modeled on layout.ts's `DockStrips`)*:
A pane placed via slot registration rather than the tiled split tree. The name survives the merge of "pinned pane" and "chrome slot" into one mechanism (slot occupancy) — it still names a real, distinct placement outcome (pinned to an edge vs. tiled among siblings), it just no longer names a second, parallel registration system. Persists as a core-defined shape (slot name → ordered pane-id list), not an opaque blob — unlike a tiling algorithm's state, a list-kind slot's content is always a real pane, a concept core already understands. A pinned pane whose slot no longer exists on restore (its declaring plugin disabled/uninstalled) is promoted into the elected tiling algorithm's pane list, never closed.
_Avoid_: dock, docked pane

**Frame**:
A candidate registered into the **root slot**, a `chain`-kind slot: each frame supplies a selector over live context (terminal size, workspace, session count), and the first selector to match at render time is elected — exactly one frame is ever rendered, but which one can change as context changes (a responsive frame that collapses to one pane below some width, for instance). A frame declares which slots exist below it and how they nest, scoped to its own election (see docs/adr/0001-lazy-election-scoped-slot-children.md) — this is what `ui/App.tsx`'s current hard-coded two-ring nesting becomes: the built-in default frame, registered with an always-matching selector at the lowest priority, so an install with no custom frame plugin behaves identically to today.
_Avoid_: layout (ambiguous with **tiling algorithm** and with `layout.ts`'s persisted `Layout` type)

**Pane-host slot**:
The `chain`-kind slot a frame declares to mark where tiled panes render. Its occupant is a **tiling algorithm**; election works exactly like the root slot's frame election (live-context selectors, first match wins, re-evaluated every render).

**Tiling algorithm** *(today: layout.ts's split/weight/preset logic — `splitLayout`, `presetLayout`, `tiled`, one fixed instance)*:
A chain candidate for the **pane-host slot** (see docs/adr/0002-tiling-algorithm-as-slot-occupant.md) — a responsive algorithm can react to live terminal size the way a responsive frame does. Its output and persisted state are opaque and plugin-owned: unlike a chrome occupant, core never interprets a tiling algorithm's internal model, only stores its blob and renders what it returns. When election changes (a resize, or a config change), the newly-elected algorithm always initializes from the flat list of currently-open real panes, never from the outgoing algorithm's opaque state. An algorithm may define its own operation vocabulary beyond the universal subset (close-pane, focus-move) every algorithm supports.
_Avoid_: "not a slot occupant" (an earlier, since-revised framing — see ADR 0002)

**Layout plugin** *(umbrella term)*:
A plugin that supplies one or more of: (a) a **frame** (registers into the root slot), (b) a **slot occupant** (chrome, pane, or tiling-algorithm content in any slot), (c) both. Frame, chrome, pinned pane, and tiling algorithm are now all the same underlying mechanism — slot registration — differing only in which slot, what kind, and what shape of value. Whether "layout plugin" should stay one umbrella term or split into named roles (frame plugin / tiling plugin) is still open.
