/**
 * CLI-side read of plugin command declarations from a live session daemon.
 * Help and command parsing never load plugins themselves; they ask the daemon
 * the caller already resolved (flag, then AMUX_DAEMON_SESSION, then default).
 */
import type * as FileSystem from "effect/FileSystem";
import { Effect } from "effect";
import { daemonAlive } from "./client.ts";
import { ControlError } from "./control.ts";
import { controlCall, toControlError } from "./control-client.ts";
import type { PluginCommandDeclaration } from "./plugin-behaviour.ts";
import { SessionStore } from "./session.ts";

export type FetchedPluginDeclarations = {
  readonly commands: readonly PluginCommandDeclaration[];
  /** False when no daemon answered; help prints the daemon note in that case. */
  readonly daemonAnswered: boolean;
};

/**
 * Empty commands when no daemon is alive. A live daemon that fails the RPC is
 * an error, not an empty list.
 */
export const fetchPluginDeclarations = (
  sessionId: string,
): Effect.Effect<FetchedPluginDeclarations, ControlError, SessionStore | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (!(yield* daemonAlive(sessionId))) {
      return { commands: [], daemonAnswered: false };
    }
    const declarations = yield* controlCall(sessionId, (control) =>
      control.PluginDeclarations(),
    ).pipe(Effect.mapError(toControlError));
    return { commands: declarations.commands, daemonAnswered: true };
  });
