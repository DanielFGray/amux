/**
 * Plugin-facing live session surface of the daemon: message, prompt, and
 * capture. Plugin commands and actions read this from Effect context.
 *
 * The in-process daemon provides one layer built from the session host; a
 * later plugin-host process will implement the same service as RPC. Prepare,
 * kill, write, and pids stay on the workspace transaction — they carry live
 * handles that must not cross a socket.
 */
import { Context, Effect, Layer, Schema as S } from "effect";
import { errorMessage } from "./error-message.ts";
import type { OwnerJsonText } from "./layout.ts";
import { type PromptOptions, type PtyError } from "./effect/SessionRegistry.ts";

const describe = errorMessage;

export class DaemonSessionsError extends S.TaggedError<DaemonSessionsError>()(
  "DaemonSessionsError",
  { message: S.String },
) {}

const sessionsError = <E>(error: E): DaemonSessionsError =>
  S.is(DaemonSessionsError)(error) ? error : new DaemonSessionsError({ message: describe(error) });

/** What the host must expose for {@link buildDaemonSessions}. */
export interface DaemonSessionsHost {
  readonly message: (id: string, message: OwnerJsonText) => Effect.Effect<void, PtyError>;
  readonly prompt: (
    id: string,
    text: string,
    options?: PromptOptions,
  ) => Effect.Effect<void, PtyError>;
  readonly capture: (id: string) => Effect.Effect<string, PtyError>;
}

export interface DaemonSessionsService {
  /**
   * Deliver an opaque payload to a live session's backend. Core assigns no
   * meaning — a turn prompt, an interrupt, a permission answer are all just
   * this, interpreted by whichever plugin's worker reads it. The worker
   * decodes through its own Schema (e.g. NativeControl).
   */
  readonly message: (
    id: string,
    message: OwnerJsonText,
  ) => Effect.Effect<void, DaemonSessionsError>;
  readonly prompt: (
    target: string,
    text: string,
    options?: PromptOptions,
  ) => Effect.Effect<void, DaemonSessionsError>;
  readonly capture: (session: string) => Effect.Effect<string, DaemonSessionsError>;
}

export class DaemonSessions extends Context.Service<DaemonSessions, DaemonSessionsService>()(
  "amux/DaemonSessions",
) {}

export const buildDaemonSessions = <HostError>(
  getHost: Effect.Effect<DaemonSessionsHost, HostError>,
): DaemonSessionsService => ({
  message: (id, message) =>
    getHost.pipe(
      Effect.flatMap((host) => host.message(id, message)),
      Effect.mapError(sessionsError),
    ),
  prompt: (target, text, options) =>
    getHost.pipe(
      Effect.flatMap((host) => host.prompt(target, text, options)),
      Effect.mapError(sessionsError),
    ),
  capture: (session) =>
    getHost.pipe(
      Effect.flatMap((host) => host.capture(session)),
      Effect.mapError(sessionsError),
    ),
});

export const makeDaemonSessions = <HostError>(
  getHost: Effect.Effect<DaemonSessionsHost, HostError>,
): Layer.Layer<DaemonSessions> => Layer.succeed(DaemonSessions, buildDaemonSessions(getHost));
