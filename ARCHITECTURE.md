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

## Trust model for process self-reports

The process-state socket (one per daemon, mode `0600` under the session root)
accepts two requests from processes running as the daemon's Unix user:
`process.state`, the generic idle/running/blocked/done self-report, and
`topic.publish`, the same door opened up to an arbitrary namespaced JSON
topic a plugin owns the meaning of — the agent-awareness plugin's
identity/state report is one such topic, published by the opencode hook
asset. Core validates only the generic envelope shape (session id, topic
name, JSON payload) and routes both through one durable topic log; it never
inspects or interprets a plugin's payload.

These reports are advisory, not authority. A hook runs inside somebody
else's process — the agent it is reporting on — so any pane's hook can claim
anything about that pane's session, and nothing on this socket distinguishes
a truthful report from a fabricated one. The trust boundary here is the same
one tmux and every other same-user multiplexer already has: every pane a
daemon supervises runs as the daemon's own user, so those panes are mutually
trusted with each other and with the daemon, the same way two panes in one
tmux server are. The socket's `0600` mode and its session-root permissions
keep a _different_ Unix user from connecting at all; they do nothing to stop
one of this daemon's own panes from naming another of its own sessions, and
nothing here tries to. The one boundary the daemon does enforce past "same
user": a report must name a backend id this daemon actually spawned, or it
is silently dropped. A session id is a place to file a fact, not a
credential; a sibling pane in the same daemon can still name it.

A topic name is a namespace for meaning, not a grant of anything. Owning a
topic (per this plugin/session boundary) lets a plugin decide how to
interpret its own payload; it grants no authority over any other plugin,
resource, or capability. Concretely: a hook's claim — "I am opencode",
"I am idle", or any other `topic.publish` payload — must never by itself
authorize a credential to be used, a permission to be granted, a command to
be run, or any other privileged or automated action. Anything that gates a
consequential action must verify it through a channel that is not just
"a pane said so" — the harness's own provider/credential layer, an explicit
user action, or a check that does not take a same-user pane's self-report as
proof of anything beyond "this pane would like this to be true."

## Plugins, and where an agent harness lives

amux is a multiplexer with a plugin system. Core projects neutral process facts
(`idle`, `blocked`, `running`, …) and owns session kinds, supervision, the
framed attach protocol, the command registry, and the region/panel model. It
contains no provider, no model, no credential, no prompt, and no turn loop.
Agent awareness is policy, so it lives in a plugin; running a turn lives in a
harness plugin.

Recognising a process as claude/codex/opencode is "which executables count as
agents", which the rule below assigns to a default plugin. One piece of that
policy still sits in core and is tracked for migration: the turn, tool and
permission vocabulary in `AttachProtocol.ts`.

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

Core features ship as **default plugins**, not as core. A default plugin is an
ordinary plugin that happens to be registered in the default list: it has no
core special case, so disabling it or replacing it with a userspace plugin is
the same operation for anything. Layout presets, ui chrome like the tab bar,
agent-awareness (the detection and notification surfaces tmux lacks), and the
harness are all candidates or already plugins. The dividing rule is policy
versus algebra: algebra (the layout tree and its transforms, pane lifecycle, the
frame protocol, regions) stays in core because a plugin needs it to exist;
policy (which arrangements exist, what the chrome shows, which executables count
as agents) becomes a default plugin because someone will want a different
answer. A feature that lands as core algebra and then gains an opinion moves out
to a default plugin; a default plugin must never require a core edit to replace.

The harness is a plugin now: `@danielfgray/amux-plugin-agent-harness` registers the
`agent.new` binding, contributes the `native` pane view, owns the model picker,
and builds its own credential and model-catalog layers, so core hands it
nothing. `agent.new` carries the command to spawn, which is what makes a
competing harness possible — core no longer names an entry point.

The model picker is the worked example of a plugin owning a modal. It is an
ordinary overlay panel with its own `visible` and `keys`, registered through
`registerPanel` like any other, and it reads and writes `agent.model` through
the panel context. Nothing in core mentions a model. The settings window reaches
it without knowing what it is: an option whose value is chosen from a list
cannot be edited with ←/→, so enter on that row dispatches the command with the
option's own name, and whoever owns the option registers it.

Plugins may register user-configurable settings sections. Core renders and
navigates those sections without knowing their contents; the harness registers
provider authentication and owns the integration and credential layers it
needs. A client without the harness has no LLM settings or provider services.

Plugin reloads do not restart agent work. A plugin scope owns registrations and
its UI fibers only. Agent workers, conversation persistence, and the daemon's
semantic event log belong to the session supervisor. Reloading may remount a
pane view, but the replacement view synchronizes from that log before showing
the conversation, so an in-progress turn continues while the UI code changes.

Vocabulary. A _session_ is a daemon-owned backend instance — a supervised PTY
today, an LLM coding-agent session later — and every attach-frame field named
`session` identifies one. The client's live handle on one is a `SessionHandle`
(`session-handle.ts`): the terminal, the process and the state projection, keyed
by the same id the attach socket speaks. It is a handle rather than a `Session`
because the session is the daemon's — `session.ts` holds the persisted record of
the same thing, and closing a handle loses a view, not a process. _Backend_
belongs to `backend.ts` and means where a session's bytes come from, which is
why the handle is not called that. A _pane_ is a placed leaf of a window holding
`{ id, content }`, where content is a pty session or a plugin view (with an
optional backend session — see layout.ts PaneContent); _agent_ means an LLM
coding agent, never the supervised PTY. Session lifecycle
commands use the `session.*` namespace; `agent.*` is reserved for LLM
interaction.

The daemon migration uses Effect at the ownership boundary. `SessionRegistry.ts`
owns scoped backend acquisition and release, `AttachProtocol.ts` and
`AttachHub.ts` define Schema-validated frames and bounded per-client queues, and
`SessionSupervisor.ts` owns the per-session screen models that make replay
possible. `workspace.ts` owns renderer-free transforms and the daemon owns
persistence; client-side `Window` and `SpaceSet` objects are render projections,
not a second writable workspace authority.

The daemon's own lifecycle — `stopped -> starting -> running -> closed` — is one
Effect Machine actor (`src/daemon.ts`). The attach runtime, host service,
control server scope and heartbeat fiber live together in the machine's state,
never as independently-nullable fields, and the seven host verbs (spawn, kill,
live, buffers) are mailbox procedures that read their resources off the
committed state and reject with "daemon not started" outside the live states.
Startup is split in two on purpose: the host commits in `starting` before
restore and the default space run, because those run the workspace transaction,
which reads the host off the machine state and the mailbox cannot serve its own
transition. Shutdown runs on the actor fiber; closing the daemon scope happens
on a detached fiber so the teardown survives the scope it dismantles. The actor
lives in a scope nothing closes, because after shutdown the service must still
answer (a `liveSessions()` reads `[]` off the closed state).

Native prompt admission is separate from execution. The project store records
one inbox row before the harness worker schedules it. Caller-supplied ids make
retries idempotent and reject a different prompt or delivery mode; `resume:
false` records work without waking execution. `steer` is selected before the
queued FIFO, while `queue` waits for the next idle boundary. The store contains
only session, prompt, delivery and admission facts. It does not know a
provider, model, credential or turn loop. The worker is the executor and may
be interrupted without deleting inbox rows. A worker restart rehydrates rows
that were admitted with resume enabled.

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
