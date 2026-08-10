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

Plugins must invoke workspace commands through `ctx.panel.run()` and must not mutate client projection objects or access terminal handles.
