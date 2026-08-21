# amux

TypeScript terminal multiplexer prototype using OpenTUI and libghostty-vt.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun start
```

Set `GHOSTTY_VT_LIB_DIR` when libghostty-vt is not at the development default path, or set `GHOSTTY_VT_LIB` to the full shared-library path.

## Sessions

The daemon owns PTYs and the renderer-free workspace model; clients attach over Unix sockets and project the current generations into OpenTUI renderables. Start the daemon with `bun run daemon [session-id]`. Detailed ownership, protocol, replay, vocabulary, and persistence invariants are documented in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Keys

`^a ?` opens the keybind list, which is also the keybind editor: `⏎` opens the action picker to replace a binding, and `a` opens it to add one. The picker lists the same actions as the command palette, including unbound actions. After an action is chosen, it shows unused keys and captures one; keys already used by another action are rejected. `u` restores the default, `d` unbinds it, and `s` saves. The prefix is the first row, so it is rebound the same way as everything else — change it and every binding follows.

Settings live in `$XDG_CONFIG_HOME/amux/config.json`. Only the keys you have actually changed are written, as full sequences against the `<leader>` token:

```json
{
  "keys": {
    "leader": "ctrl+b",
    "bindings": { "pane.zoom": ["<leader>f"], "app.quit": [] }
  }
}
```

An empty list leaves the command unbound. Two commands on one sequence is not an error the app refuses to start over — the settings window names the clash, and the first-registered of the two is the one that fires.

## Plugins

Plugins are trusted in-process TypeScript modules loaded at startup. The default sidebar is itself the builtin plugin `builtin:amux.sidebar`, so it can be disabled or replaced through the same configuration list:

```json
{
  "plugins": [
    { "path": "builtin:amux.sidebar", "enabled": true },
    { "path": "./plugins/status-bar.tsx", "enabled": true }
  ]
}
```

Relative paths resolve from the config directory. A plugin must default-export an object with `id`, `apiVersion: "1"`, and an Effect `effect` function. The effect receives a value-only `PanelContext`, registers panels with `ctx.registerPanel`, and everything registered is removed when the plugin is disabled or fails. `PanelContext.display()` provides cloned space, window, and agent rows with state and blocked counts; `examples/agent-dashboard.tsx` uses that projection for a live agent roster. See `examples/status-bar.tsx` for a minimal bottom-bar plugin, or `examples/agent-triage.tsx` for a right-side attention rail.

In addition to configured entries, amux discovers entry files in `$XDG_CONFIG_HOME/opentui-herdr/plugins/` (or `~/.config/opentui-herdr/plugins/`). Discovery uses the same validation and failure isolation as configured plugins. The host can enable or disable a plugin at runtime; disabling closes its scope immediately and enabling it acquires a new one. Module state is not persistence: use `ctx.kv` for state that must survive disable and re-enable.

Plugins must invoke workspace commands through `ctx.panel.run()` and must not mutate client projection objects or access terminal handles.

### Plugins that depend on plugins

A plugin publishes a service with `ctx.provide(Tag, service)` and names the services it cannot run without in `inject`. Wrap the definition in `definePlugin` so the two halves are checked against each other:

```ts
export default definePlugin({
  id: "amux.mentions",
  apiVersion: "1",
  inject: [SearchService],
  effect: (ctx) =>
    Effect.gen(function* () {
      const search = yield* SearchService
      // ...
    }),
})
```

A plugin waits until every injected service has a provider, so load order follows who provides what, not the order of the config file. When a provider stops or is reloaded, its dependents unwind first, while its services are still theirs to use, and then go back to waiting; the replacement picks them up as soon as it provides. `ctx.get(Tag)` is the soft read for a capability a plugin can do without: it never waits, and it returns nothing once the provider leaves.

### Reloading a plugin

`amux plugin.reload [plugin]` loads a plugin's source again and runs the new version in place of the old one — from the command palette, from a shell, or from an agent that has just edited it. With no argument every plugin reloads. The request goes through the daemon, so every attached client reloads, not only the one you typed it into.

#### Reload boundary

The reload boundary is the plugin's directory, rooted at its entry file. The HMR
loader carries a generation token through imports inside that directory. Imports
outside it keep the host's module instance, including the Effect and OpenTUI
instances shared with the rest of the client.

The alternative is import-graph classification: repeatedly accept a changed
module when an import accepts it, decline it when all imports decline it, and
decline cycles by default. That can reload a smaller set of files, but it adds a
graph cache, invalidation and stale-entry rules, and difficult ownership cases
for dynamic imports and shared state. It does not improve amux's required
guarantee: plugin code may be replaced without duplicating host state. A
directory is an explicit, stable ownership boundary and is also easy to explain
to plugin authors. We therefore keep the directory-rooted boundary.

This classification decision is independent of reload transactionality. The
reload lifecycle still uses the two-scope, commit-or-rollback design: start the
new generation beside the old one, publish it only after activation succeeds,
then unload the old generation. A failed activation closes the new scope and
leaves the old generation visible.

A plugin's reloadable unit is its entry file plus the directory named after it: `agent-harness.tsx` reloads together with everything in `agent-harness/`. Modules outside that directory — amux itself, `effect`, `solid-js` — stay the single instance the whole client shares, so a plugin never ends up talking to its own private copy of a registry.

Nothing a plugin held in module scope survives; that is what makes it a reload. `ctx.kv` does survive, and so does anything the daemon owns, which is why a chat pane comes back mid-conversation with its transcript intact. The last version that worked is the floor: a source that will not import is refused before the running one is touched, and a version that fails to start gives way to the one it replaced.

A reload replaces the running plugin with whatever the file says now, so a plugin that cannot be read from disk — inside a compiled binary — cannot be reloaded.

## Agent permissions

Everything the bundled agent does that changes something asks first. Reading, globbing and grepping do not. A blocked pane shows the call and four answers: `o` once, `a` always, `d` deny, `e` deny with a reason the model is told.

`always` records a rule, and the rule is shown before you accept it — `git status --porcelain` records `bash git status *`, a file write records `write ./**`. A command is split on `;`, `&&`, `||` and `|` before it is judged, so a rule for `ls *` does not let `ls; rm -rf ~` through; a command containing `$(…)`, backticks, `<(…)` or `eval` always asks, because its text is not what runs.

Approvals are per project. They live in `$XDG_STATE_HOME/amux/projects/<project>/amux.db`, keyed on the repository root, so a rule follows every worktree of one repo and reaches no other.

A standing rule for every project goes in `config.json`. `deny` there cannot be overridden by an approval:

```json
{
  "permissions": [
    { "action": "bash", "resource": "rm *", "effect": "deny" },
    { "action": "read", "resource": "*.env", "effect": "ask" }
  ]
}
```
