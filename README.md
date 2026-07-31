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

## Sessions

The current daemon owns session metadata only. `src/main.tsx` still owns each
live PTY and ghostty terminal, so closing the UI terminates those processes and
restart cannot restore their running state. Do not use this daemon as if it were
already a multiplexer server.

Start the metadata daemon with `bun run daemon [session-id]`; clients use the
Unix socket under `$XDG_STATE_HOME/opentui-herdr/sessions/<session-id>/`.
`attach` and `detach` are single-client lifecycle markers, `status` is for
inspection, and `stop` removes the session metadata. Supply a stable client id
to both attach and detach, for example `bun run session -- attach work tui-1`
and `bun run session -- detach work tui-1`; a second client is rejected. State is
versioned JSON in `session.json`; writes go through a temporary file and rename,
with the prior generation retained as `session.json.prev` for recovery after a
hard kill. The daemon directory also has an atomic ownership lock and a lease
containing its PID and heartbeat.

The next integration task is to move `Agent` behind a daemon-owned PTY service:
define framed attach streams for PTY output/input/resize and terminal snapshots,
then make `main.tsx` hydrate spaces/windows/agents from persisted metadata. Only
after that should client disconnect mean detach rather than process exit; the
integration must also cover daemon restart, SIGWINCH ordering, orphan cleanup,
and concurrent attach rejection.

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
