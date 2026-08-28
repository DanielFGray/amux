/**
 * The one vocabulary for what a supervised process is doing.
 *
 * Core is agent-AWARE, not an agent: it knows a pane's process is idle,
 * running, blocked on something, or done, and nothing more specific than
 * that. `failed` and `detached` are not process states — they are what an
 * agent-aware plugin derives from this vocabulary plus the neutral facts a
 * process backend already exposes (`exitCode`, `detached`). See
 * `@danielfgray/amux-agent-awareness`'s `display-state.ts` for that derivation.
 *
 * The wire (EventBus's session.state, the process self-report socket) carries
 * this only as an opaque string: those transports must not need editing
 * whenever this vocabulary grows a state, so none of them import this module.
 * Instead every plane that means something by the value — the sidebar glyph,
 * the socket a process's hook writes, a harness relabeling a generic topic
 * frame — validates and interprets it at its own boundary via
 * `isProcessState`, and every union and `Record<ProcessState, _>` derives
 * from the names and schema defined once here.
 *
 * This module deliberately depends on nothing but Node and Effect: the leaf
 * modules that need the vocabulary (detect, backend) must not inherit the
 * import graph of the ones that route it.
 */
import net from "node:net";
import { Schema as S } from "effect";
import type { JsonValue } from "./effect/AttachProtocol.ts";

/**
 * The name for every state, so no call site spells one out.
 *
 * A value and a type share this name deliberately: TypeScript keeps the two in
 * separate namespaces, so one import gives a call site both `ProcessState.Idle`
 * to write and `ProcessState` to annotate with.
 */
export const ProcessState = {
  Idle: "idle",
  Running: "running",
  Blocked: "blocked",
  Done: "done",
} as const;

export const ProcessStateSchema = S.Literals([
  ProcessState.Idle,
  ProcessState.Running,
  ProcessState.Blocked,
  ProcessState.Done,
]);
export type ProcessState = typeof ProcessStateSchema.Type;

export const isProcessState = (value: JsonValue): value is ProcessState =>
  S.is(ProcessStateSchema)(value);

/**
 * Write one self-report to a session's process-state socket.
 *
 * Takes the socket path rather than a session id: the caller that knows which
 * pane this is already knows where to write, and keeping session naming out of
 * here is what lets the vocabulary above stay dependency-free.
 */
export function reportProcessState(
  socketPath: string,
  session: string,
  state: ProcessState,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const request = JSON.stringify({
      id: `amux:process-state:${Date.now()}`,
      method: "process.state",
      params: { session, state },
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(500, () => finish(new Error("process state request timed out")));
    socket.once("error", finish);
    socket.once("data", () => finish());
    socket.once("connect", () => socket.write(`${request}\n`));
  });
}
