# opentui-herdr

TypeScript terminal multiplexer prototype using OpenTUI and libghostty-vt.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

Set `GHOSTTY_VT_LIB_DIR` when libghostty-vt is not at the development default
path, or set `GHOSTTY_VT_LIB` to the full shared-library path.

## Keys

`^a ?` opens the keybind list, which is also the keybind editor: `⏎` records a
new key for the selected row, `u` restores the default, `d` unbinds it, and `s`
saves. The prefix is the first row, so it is rebound the same way as everything
else — change it and every binding follows.

Settings live in `$XDG_CONFIG_HOME/opentui-herdr/config.json`. Only the keys you
have actually changed are written, as full sequences against the `<leader>`
token:

```json
{
  "keys": {
    "leader": "ctrl+b",
    "bindings": { "pane.zoom": ["<leader>f"], "app.quit": [] }
  }
}
```

An empty list leaves the command unbound. Two commands on one sequence is not
an error the app refuses to start over — the settings window names the clash,
and the first-registered of the two is the one that fires.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
