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

The daemon owns the PTYs, not just the metadata: `Agent`s are built on
daemon-owned processes, so closing a client detaches it and the processes keep
running, and a later client reattaches to them. Start the daemon with
`bun run daemon [session-id]`; clients use the Unix socket under
`$XDG_STATE_HOME/opentui-herdr/sessions/<session-id>/`. `attach` and `detach`
are not RPC operations: attachment ownership belongs to the live attach socket.
Use `status` for inspection and `stop` to remove the session. The client presents
a stable ID on the attach stream so reconnects can be distinguished from a
second client; a second client is rejected.
State is versioned JSON in `session.json`, written via a temporary file and
rename. The daemon directory also has an atomic ownership lock and a lease
containing its PID and heartbeat.

Two sockets do different jobs. The RPC socket answers questions about the
session and hangs up; the attach socket *is* an attachment — a client holds it
open and PTY bytes flow both ways over it as newline-framed JSON frames
(`output`, `input`, `resize`, `exit`, `ping`/`pong`, plus `sync`). Its EOF is
how the daemon learns the client died. The daemon runs a ghostty terminal per
agent as a screen model; when a client adopts an agent it sends `sync`, and the
daemon answers with the agent's current screen serialized as VT (modes
included, alternate screen and all) before the live bytes, so a reattaching
pane is not blank until the program next redraws.

The daemon migration uses Effect only at this boundary. `src/effect/PtyRegistry.ts`
owns scoped PTY acquisition and release, `AttachProtocol.ts` and `AttachHub.ts`
define Schema-validated frames and bounded per-client queues, and
`PtySupervisor.ts` owns the per-agent screen models that make replay possible.
The renderer, Solid state, Ghostty FFI, and pane layout remain imperative by
design.

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
