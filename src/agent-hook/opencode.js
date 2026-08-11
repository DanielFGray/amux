// AMUX_AGENT_STATE_PLUGIN=1
// Installed by `amux agent-hook opencode install`; remove with the matching uninstall command.
//
// This file runs inside the user's opencode, not inside amux. It therefore may
// not hang, throw, or slow the agent down under any circumstance: every socket
// is bounded by a timeout, every failure is swallowed, and a report that cannot
// be delivered is dropped rather than retried. A mux that makes opencode
// stutter is worse than a mux that shows a stale dot.
import net from "node:net";

/** Longest an opencode event handler may be delayed by a report. */
const TIMEOUT_MS = 500;

// Exported so amux's own tests can check these values against the one schema
// that defines them. This file cannot import that schema: it is loaded by
// opencode, not by amux, and may not reach into a codebase that is not there.
export const STATE_BY_EVENT = new Map([
  // OpenCode is actively making progress during these events.
  ["session.status:active", "working"],
  ["session.status:busy", "working"],
  ["session.status:pending", "working"],
  ["session.status:retry", "working"],
  ["session.status:running", "working"],
  ["session.status:streaming", "working"],
  ["session.status:working", "working"],
  // Idle means the turn ended and OpenCode is ready for another prompt.
  ["session.status:idle", "idle"],
  // These events stop the turn for a user decision, so they are blocked.
  ["permission.asked", "blocked"],
  ["question.asked", "blocked"],
  ["session.error", "failed"],
  ["session.idle", "idle"],
]);

function stateFor(event) {
  if (event.type === "session.status") {
    const status =
      typeof event.properties?.status === "string"
        ? event.properties.status
        : event.properties?.status?.type;
    return typeof status === "string"
      ? STATE_BY_EVENT.get(`session.status:${status.toLowerCase()}`)
      : undefined;
  }
  return STATE_BY_EVENT.get(event.type);
}

/**
 * One line of JSON to amux's agent-state socket, resolving once the daemon has
 * answered or the timeout expires — whichever is first. Never rejects.
 */
function report(socketPath, agent, state) {
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve();
    };
    try {
      socket = net.createConnection(socketPath);
    } catch {
      return finish();
    }
    socket.setTimeout(TIMEOUT_MS, finish);
    socket.once("error", finish);
    socket.once("data", finish);
    socket.once("close", finish);
    socket.once("connect", () => {
      try {
        socket.write(
          `${JSON.stringify({
            id: `opencode:agent-state:${Date.now()}`,
            method: "agent.state",
            params: { agent, state },
          })}\n`,
        );
      } catch {
        finish();
      }
    });
  });
}

export const AmuxAgentStatePlugin = async () => {
  const socketPath = process.env.AMUX_AGENT_STATE_SOCKET;
  const agent = process.env.AMUX_PANE_ID;
  // Not running in an amux pane: contribute nothing rather than guess a path.
  if (!socketPath || !agent) return {};

  // Reports are strictly ordered and never concurrent. Two connections racing
  // could deliver working-then-idle out of order and leave a finished agent
  // showing a spinner, so each report waits for the previous one to settle.
  let queue = Promise.resolve();
  let last;
  return {
    event: async ({ event }) => {
      const state = stateFor(event);
      // Streaming fires continuously; only transitions are worth a syscall.
      if (!state || state === last) return;
      last = state;
      queue = queue.then(() => report(socketPath, agent, state));
      await queue;
    },
  };
};
