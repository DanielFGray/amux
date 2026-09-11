// AMUX_AGENT_STATE_PLUGIN=1
// Installed by `amux agent-hook opencode install`; remove with the matching uninstall command.
// managed by amux; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// AMUX_INTEGRATION_ID=opencode
// AMUX_INTEGRATION_VERSION=1
//
// This file runs inside the user's opencode, not inside amux. It therefore may
// not hang, throw, or slow the agent down under any circumstance: every socket
// is bounded by a timeout, every failure is swallowed, and a report that cannot
// be delivered is dropped rather than retried. A mux that makes opencode
// stutter is worse than a mux that shows a stale dot.
import net from "node:net";

/** Longest an opencode event handler may be delayed by a report. */
const TIMEOUT_MS = 500;

const SOURCE = "amux:opencode";
const AGENT_KIND = "opencode";

// Exported so amux's own tests can check these values against the one schema
// that defines them. This file cannot import that schema: it is loaded by
// opencode, not by amux, and may not reach into a codebase that is not there.
export const STATE_BY_EVENT = new Map([
  ["session.status:active", "working"],
  ["session.status:busy", "working"],
  ["session.status:pending", "working"],
  ["session.status:retry", "working"],
  ["session.status:running", "working"],
  ["session.status:streaming", "working"],
  ["session.status:working", "working"],
  ["session.status:idle", "idle"],
  ["permission.asked", "blocked"],
  ["question.asked", "blocked"],
  ["session.error", "failed"],
  ["session.idle", "idle"],
]);

/**
 * Core's `process.state` only ever accepts idle/running/blocked/done — no
 * `failed`, which is awareness presentation, not process lifecycle. `working`
 * (awareness's word) maps to `running` (core's word); every other awareness
 * state core already spells the same way.
 */
export function coreProcessState(state) {
  if (state === "working") return "running";
  if (state === "failed") return "idle";
  return state;
}

export const AGENT_AWARENESS_IDENTITY_TOPIC = "amux.agent-awareness/identity-state";

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

function sessionIDFromProperties(properties) {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

/**
 * One line of JSON to amux's process-state socket, resolving once the daemon
 * has answered or the timeout expires — whichever is first. Never rejects.
 */
function send(socketPath, method, params) {
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
            id: `opencode:${method}:${Date.now()}`,
            method,
            params,
          })}\n`,
        );
      } catch {
        finish();
      }
    });
  });
}

export const AmuxAgentStatePlugin = async () => {
  const socketPath = process.env.AMUX_PROCESS_STATE_SOCKET;
  const agent = process.env.AMUX_AGENT_ID;
  const paneId = process.env.AMUX_PANE_ID;
  // Not running in an amux pane: contribute nothing rather than guess a path.
  if (!socketPath || !agent) return {};

  // Track child sessions so their events cannot replace the pane's root session.
  const childSessions = new Map();
  let reportedRootSessionID;
  let reportSeq = Date.now() * 1000;
  const nextSeq = () => {
    reportSeq += 1;
    return reportSeq;
  };

  // Transitions are strictly ordered and never concurrent with each other:
  // two transitions racing could deliver working-then-idle out of order and
  // leave a finished agent showing a spinner, so each transition waits for
  // the previous one to settle before starting. Within one transition, the
  // channels it reports on go out concurrently — sequential sends would
  // double the wait past this hook's one-timeout handler-delay contract.
  let queue = Promise.resolve();
  let last;

  const reportSession = (sessionID, startSource) => {
    if (!paneId || !sessionID) return Promise.resolve();
    const params = {
      paneId,
      source: SOURCE,
      agent: AGENT_KIND,
      seq: nextSeq(),
      agentSessionId: sessionID,
    };
    if (startSource) params.sessionStartSource = startSource;
    return send(socketPath, "pane.report_agent_session", params);
  };

  const maybeReportRoot = (sessionID) => {
    if (!sessionID || childSessions.has(sessionID)) return Promise.resolve();
    if (sessionID === reportedRootSessionID) return Promise.resolve();
    const startSource = reportedRootSessionID === undefined ? undefined : "new";
    reportedRootSessionID = sessionID;
    return reportSession(sessionID, startSource);
  };

  return {
    event: async ({ event }) => {
      const type = event?.type;
      const properties = event?.properties ?? {};
      const sessionID = sessionIDFromProperties(properties);
      const info = properties.info;
      if (info?.id && info.parentID) {
        childSessions.set(info.id, info.parentID);
      }

      if (sessionID && childSessions.has(sessionID)) {
        // Child events may still project process state via the root, but never
        // attach the child's session id to the pane.
        const state = stateFor(event);
        if (!state || state === last) return;
        last = state;
        let rootSessionID = sessionID;
        while (childSessions.has(rootSessionID)) {
          rootSessionID = childSessions.get(rootSessionID);
        }
        queue = queue.then(() =>
          Promise.all([
            send(socketPath, "process.state", {
              session: agent,
              state: coreProcessState(state),
            }),
            send(socketPath, "topic.publish", {
              session: agent,
              topic: AGENT_AWARENESS_IDENTITY_TOPIC,
              payload: { agent: AGENT_KIND },
            }),
            maybeReportRoot(rootSessionID),
          ]),
        );
        await queue;
        return;
      }

      if (
        type === "session.created" ||
        type === "session.updated" ||
        type === "session.status" ||
        type === "session.idle"
      ) {
        queue = queue.then(() => maybeReportRoot(sessionID));
      }

      const state = stateFor(event);
      // Streaming fires continuously; only transitions are worth a syscall.
      if (!state || state === last) {
        await queue;
        return;
      }
      last = state;
      queue = queue.then(() =>
        Promise.all([
          send(socketPath, "process.state", { session: agent, state: coreProcessState(state) }),
          send(socketPath, "topic.publish", {
            session: agent,
            topic: AGENT_AWARENESS_IDENTITY_TOPIC,
            payload: { agent: AGENT_KIND },
          }),
          maybeReportRoot(sessionID),
        ]),
      );
      await queue;
    },
  };
};

export default AmuxAgentStatePlugin;
