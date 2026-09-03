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
