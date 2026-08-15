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

## Choose the correct primitive

- Spaces group work, windows group layouts, and panes are views of daemon-owned sessions.
- Pane commands change layout, focus, terminal input, and terminal capture. Use them for shells, tests, servers, and raw terminal control.
- Agent commands start and coordinate coding-agent sessions. Use them when amux must track a turn, durable events, interruption, or a permission request.
- Session commands act on the backend that a pane displays. A session can survive layout changes and can be shown in a different pane.
- The current workspace target is implicit for layout commands. Commands that act on a session need an explicit session or the managed-pane context.

IDs are opaque. \`AMUX_PANE_ID\` identifies the caller pane; it is not a session ID. Use IDs returned by commands and captures. Do not derive IDs from layout order, names, or examples.

## Run work in another pane

Create a pane with \`pane.split\`, which reports the \`session\` and \`pane\` it created. Address later commands by those ids rather than by focus: focus belongs to whoever is driving the UI, and it moves.

Send the command with \`pane.send-keys\` against the session id, and read the result with \`pane.capture\`. Capture returns terminal text, so wait on the output you expect rather than on elapsed time.

Starting and prompting another agent is available: \`agent.new\`, \`agent.prompt\`, and \`agent.watch\` are exposed to agents, so you can spawn, prompt, and observe a coding-agent session. \`agent.permission\` and \`agent.interrupt\` remain human-gated: the approval loop and the interrupt escape hatch stay with the user.

## Safety

- Keep work in the caller's daemon session. Do not supply another daemon session unless the user explicitly requests it.
- Use explicit IDs when a command can affect another pane or session. Do not rely on UI focus controlled by another client.
- Do not close spaces, windows, panes, or sessions that you did not create unless the user explicitly asks.
- Closing a pane can stop its backend when no other pane shows it. Closing a window or space can stop all agents inside it.
- Do not use synchronized panes for background work: input is sent to every pane in the window.
- Do not stop the daemon or kill the amux process from an active managed session unless the user explicitly asks to end it.
- Treat permission requests as user decisions. Do not approve destructive or privileged actions without the required authority.
`;
}
