import { commandGroups } from "./command-cli.ts";

export function generateSkill(): string {
  const groups = commandGroups()
    .map((group) => `amux ${group}`)
    .join("\n");

  return `---
name: amux
description: "Control amux, an agent-aware terminal multiplexer. Use only when the user asks to use amux or to inspect or control its spaces, windows, panes, sessions, or agents. Requires an amux-managed pane."
---

# amux

amux organizes terminals into spaces, windows, and panes. The daemon owns the workspace and sessions; the CLI sends ordered commands to that daemon.

Before any control command, verify that this agent runs in an amux-managed pane:

\`\`\`bash
test -n "\${AMUX_DAEMON_SESSION:-}" && test -n "\${AMUX_PANE_ID:-}"
\`\`\`

If this check fails, state that the process is not in an amux-managed pane and stop. Do not control the default or focused session from outside amux.

## Discover commands

The installed binary is the authority for syntax. Run a command group without a nested command to print its complete current syntax:

\`\`\`bash
${groups}
\`\`\`

Run \`amux --help\` for the full surface. Do not probe a nested command with missing arguments: a command whose arguments are optional can execute. Command results are plain text or JSON; read IDs from results and live state instead of predicting them.

## IDs and addressing

IDs are opaque, stable handles, never reused after close. Spaces are \`s1\`, \`s2\`, and a pane id carries the space that owns it: \`s1:p3\`. Agent (session) ids are opaque strings like \`agent-…\`. \`AMUX_PANE_ID\` identifies the caller's pane; \`AMUX_AGENT_ID\` identifies the session the caller runs in. Use IDs returned by commands and reads; do not derive IDs from layout order, names, or examples.

Every pane command takes an optional target, resolved by the daemon:
- \`--pane <id>\` — act on that named pane wherever it lives.
- \`--current\` — act on the caller's own pane (resolved server-side, never substituted by the CLI).
- neither — act on the focused pane, which belongs to whoever is driving the UI and moves. A delegating agent must name a target rather than rely on it.

Add \`--no-focus\` to a command batch to do background work: the command's structure applies, but the human's view — active space, active window, focused pane — is left exactly as it was.

## Read the workspace

The narrow read verbs answer questions without the whole snapshot, and no read marks anything seen or moves focus:

\`\`\`bash
amux space.list              # spaces, active window, window count
amux window.list             # windows, their panes and focus
amux pane.list               # panes, their home, session and focus flags
amux pane.current --current  # the caller's own pane (or --pane <id>)
amux pane.layout --current   # a pane's geometry, for choosing a split direction
amux agent.list              # agents with their home and state
amux agent.get <session-id>  # one agent, by its session id
\`\`\`

\`pane.layout\` reports the pane's position and size in cells plus every pane's rect, so an agent can follow "split a wide pane to the right, a narrow or tall one down" from its own geometry.

## Run work in another pane

Create a pane with \`pane.split --no-focus\`, which reports the \`session\` and \`pane\` it created. Address later commands by those ids rather than by focus: focus belongs to whoever is driving the UI, and it moves.

\`\`\`bash
amux pane.split --axis row --no-focus
amux pane.send-keys --pane s1:p3 --keys "bun test"
amux pane.capture --pane s1:p3
amux pane.close --pane s1:p3
\`\`\`

\`pane.capture\` returns terminal text, so wait on the output you expect rather than on elapsed time. A pane moved to another space gets a new space-qualified id; the move reports both the new id and \`previous_pane_id\`, so re-anchor from the result rather than the stale handle. A closed id is never reissued, so a stale handle no-ops instead of reaching the wrong pane.

## Delegate work to another agent

Start a sibling coding agent with \`agent.new\`, which reports the \`session\` and \`pane\` it created. Address the child by that session id: focus belongs to whoever drives the UI, and it moves.

Send work with \`agent.prompt <target> <text>\`:

- Without \`--wait\` or \`--until\`, the call returns as soon as the prompt is accepted.
- With \`--wait\`, the call blocks until the anchored turn completes (\`turn.end\`) and prints the completion event. With \`--until=<idle|working|blocked|failed|done>\`, it blocks until the agent reports that state.
- \`--timeout=<ms>\` bounds the whole wait (default 30000).
- A prompt sent while the agent is not working must produce an observed lifecycle change within five seconds, or the call fails with \`agent_prompt_stalled\`. The agent never took the work; do not keep waiting, report the failure.

Observe the child with \`agent.watch <target>\`, which streams durable events as JSON lines from a replay cursor. \`--after=<sequence>\` resumes from an earlier cursor, so a reconnect loses nothing. Events include \`turn.start\`, \`turn.end\` (with \`outcome\`), \`tool.start\`, \`tool.result\`, \`agent.status\`, and \`permission.request\`.

\`agent.permission\` and \`agent.interrupt\` stay human-gated: the approval loop above the agents answers permission requests, and interrupt is the user's escape hatch. If the child emits \`permission.request\` or reaches \`blocked\`, it is waiting on the user; do not answer it yourself.

Read the session id from the \`agent.new\` result and from \`agent.watch\` events. Do not derive it from layout order, names, or examples.

## Safety

- Keep work in the caller's daemon session. Do not supply another daemon session unless the user explicitly requests it.
- Name a pane (\`--pane\`/\`--current\`) for work that must not depend on another client's focus; use \`--no-focus\` for background work unless the user asked to switch context.
- Do not close spaces, windows, panes, or sessions that you did not create unless the user explicitly asks.
- Closing a pane can stop its backend when no other pane shows it. Closing a window or space can stop all agents inside it.
- Do not use synchronized panes for background work: input is sent to every pane in the window.
- Do not stop the daemon or kill the amux process from an active managed session unless the user explicitly asks to end it.
- Treat permission requests as user decisions. Do not approve destructive or privileged actions without the required authority.
`;
}
