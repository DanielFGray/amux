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

The daemon owns both the PTYs and the renderer-free workspace model. Workspace
commands execute there in one revision order; clients subscribe to generations
and reconcile them into OpenTUI renderables. Closing a client therefore loses
neither processes nor layout, and a later client projects the current model over
the still-running sessions. Start the daemon with
`bun run daemon [session-id]`; clients use the Unix socket under
`$XDG_STATE_HOME/opentui-herdr/sessions/<session-id>/`. A session id is a
single filename-safe component: `[A-Za-z0-9._-]+` except `.` and `..`, at most
128 characters — no path separators or control characters (the id becomes a
directory name, so it is validated before any filesystem access). `attach` and `detach`
are not RPC operations: attachment ownership belongs to the live attach socket.
Use `status` for inspection and `stop` to remove the session. Each attach
connection has independent liveness. Multiple clients may observe the same
ordered generations; a command based on an obsolete revision is rejected
rather than silently overwriting a newer client's change.
State is versioned JSON in `session.json`, written via a temporary file and
rename. The daemon directory also has an atomic ownership lock and a lease
containing its PID and heartbeat.

Two sockets do different jobs. The RPC socket answers questions about the
session and hangs up; the attach socket *is* an attachment — a client holds it
open and PTY bytes flow both ways over it as newline-framed JSON frames
(`output`, `input`, `resize`, `exit`, `ping`/`pong`, plus `sync`). Workspace
generations use a separate `workspace` frame tag and never masquerade as
terminal bytes. Its EOF is
how the daemon learns the client died. The daemon runs a ghostty terminal per
session as a screen model; when a client adopts a session it sends `sync`, and
the daemon answers with the session's current screen serialized as VT (modes
included, alternate screen and all) before the live bytes, so a reattaching
pane is not blank until the program next redraws.

Surviving vocabulary (the attach protocol was renamed off `agent`): a
*session* is a daemon-owned backend instance — a supervised PTY today, an LLM
coding-agent session later — and every attach-frame field named `session`
identifies one; a *pane* is a view of a session in a layout; *agent* means an
LLM coding agent, never the supervised PTY.

The daemon migration uses Effect at the ownership boundary. `SessionRegistry.ts`
owns scoped backend acquisition and release, `AttachProtocol.ts` and `AttachHub.ts`
define Schema-validated frames and bounded per-client queues, and
`SessionSupervisor.ts` owns the per-session screen models that make replay
possible. `workspace.ts` owns renderer-free transforms and the daemon owns persistence;
client-side `Window` and `SpaceSet` objects are render projections, not a second
writable workspace authority.

Every `SessionState` write, including attachment metadata, runs through the
daemon's model queue. A workspace command prepares reversible sessions and
gates destructive exits, completes its required process/input actions, writes
one candidate generation, then installs and publishes it before releasing
terminal exits. Before activation, a prepared session has only a private PTY,
replay terminal, and output pump: it is absent from live/status, attach/replay
lookup, and the hub. Activation after durability registers it once and releases
its replay and any exit. A failed spawn-only write aborts that private session;
there is no persisted-candidate rollback. Once a destructive action has
completed, persistence retries with bounded backoff and the daemon reports an
unhealthy status until storage recovers. Natural exits use the same retry rule:
each is an explicit durable obligation that retains its place at the head of
the model queue. Unrelated metadata cannot clear it or write an older workspace.
The terminal exit frame is held behind `persist model -> publish workspace`, so
a permanent storage failure is visible to status callers but never creates an
in-memory or client-only generation. A reversible candidate failure creates no
obligation and does not affect daemon health; a later command starts fresh.
Persistence attempts are scoped Effect fibers owned by the daemon. Shutdown
drains ordinary queued work within a fixed budget, then interrupts and joins
the active save before supervisor disposal. File writes receive Effect's abort
signal; the final rename is a synchronous commit section, so cancellation can
leave only an ignored temp file, never a background write that later installs
state after stop.

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
