# amux Architecture

## Sessions

The daemon owns both the PTYs and the renderer-free workspace model. Workspace
commands execute there in one revision order; clients subscribe to generations
and reconcile them into OpenTUI renderables. Closing a client therefore loses
neither processes nor layout, and a later client projects the current model over
the still-running sessions. Start the daemon with
`bun run daemon [session-id]`; clients use the Unix socket under
`$XDG_STATE_HOME/amux/sessions/<session-id>/`. A session id is a
single filename-safe component: `[A-Za-z0-9._-]+` except `.` and `..`, at most
128 characters — no path separators or control characters (the id becomes a
directory name, so it is validated before any filesystem access). `attach` and
`detach` are not RPC operations: attachment ownership belongs to the live attach
socket. Use `status` for inspection and `stop` to remove the session. Each attach
connection has independent liveness. Multiple clients may observe the same
ordered generations; a command based on an obsolete revision is rejected rather
than silently overwriting a newer client's change.
State is versioned JSON in `session.json`, written via a temporary file and
rename. The daemon directory also has an atomic ownership lock and a lease
containing its PID and heartbeat.

Two sockets do different jobs. The RPC socket answers questions about the
session and hangs up; the attach socket _is_ an attachment — a client holds it
open and PTY bytes flow both ways over it as newline-framed JSON frames
(`output`, `input`, `resize`, `exit`, `ping`/`pong`, plus `sync`). Workspace
generations use a separate `workspace` frame tag and never masquerade as
terminal bytes. Its EOF is
how the daemon learns the client died. The daemon runs a ghostty terminal per
session as a screen model; when a client adopts a session it sends `sync`, and
the daemon answers with the session's current screen serialized as VT (modes
included, alternate screen and all) before the live bytes, so a reattaching
pane is not blank until the program next redraws.

## Plugins, and where an agent harness lives

amux is an agent-aware multiplexer, not an agent. Core recognises that a process
in a pane is claude/codex/opencode and projects its state (`idle`, `blocked`,
`running`, …); it owns session kinds, supervision, the framed attach protocol,
the command registry, and the region/panel model. It contains no provider, no
model, no credential, no prompt, and no turn loop.

The thing that runs a turn loop is a _harness_, and a harness is a plugin —
including the one we ship. A plugin is an Effect requiring a `Scope`
(`plugin/types.ts`): load acquires, disable or crash releases, and every
registration goes with the scope. Plugins run in-process on the client and
contribute Solid JSX through the region registry, so a harness can render its
own transcript, pickers and settings, and drive the multiplexer through ordinary
commands rather than privileged access. Ours being a plugin is the acceptance
test for that API: if it needs an escape hatch, the API is unfinished and the
fix is the API.

This does not conflict with the daemon rule that an LLM never runs in the
process owning the PTYs. That rule is about the _daemon_. A plugin is client
code, and a harness that wants crash isolation spawns and supervises its own
worker child over the same framed protocol — the plugin is the supervisor, not
the LLM client. Whether it does so at all is the plugin's choice; core neither
requires a worker process nor gives one an easier path.

`SessionKind` stays `"pty" | "agent"` because `"agent"` means _a
framed-protocol child_, not _our loop_: a third-party harness is the same kind.
The pane host is not pluggable — panes are the product.

The tree does not satisfy this yet, and the deviations are tracked rather than
tolerated: `workspace.ts` hardcodes the built-in worker's entry path so no other
harness can be spawned (`ts-ade8f7`); `main.tsx` provides the integration,
credential and model-catalog layers globally; and `app.tsx` registers the
transcript panel through the privileged path, handing it the live session
object. Do not add consumers to any of those. The boundary and the conversion
order are recorded in `ts-8305f4`.

Surviving vocabulary (the attach protocol was renamed off `agent`): a
_session_ is a daemon-owned backend instance — a supervised PTY today, an LLM
coding-agent session later — and every attach-frame field named `session`
identifies one; a _pane_ is a view of a session in a layout; _agent_ means an
LLM coding agent, never the supervised PTY. Session lifecycle commands use the
`session.*` namespace; `agent.*` is reserved for LLM interaction.

The daemon migration uses Effect at the ownership boundary. `SessionRegistry.ts`
owns scoped backend acquisition and release, `AttachProtocol.ts` and
`AttachHub.ts` define Schema-validated frames and bounded per-client queues, and
`SessionSupervisor.ts` owns the per-session screen models that make replay
possible. `workspace.ts` owns renderer-free transforms and the daemon owns
persistence; client-side `Window` and `SpaceSet` objects are render projections,
not a second writable workspace authority.

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
each is an explicit durable obligation that retains its place at the head of the
model queue. Unrelated metadata cannot clear it or write an older workspace.
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
