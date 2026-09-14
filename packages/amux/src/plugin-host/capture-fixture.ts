/**
 * Test fixture: after the first Ping, retry DaemonSessions.capture until the
 * screen contains the expected text, then write it to the output path.
 *
 * argv: [exec, fixture, outPath, sessionId, expectText]
 * AMUX_PLUGIN_CAPABILITIES_SOCKET comes from the supervisor env.
 */
import {
  Config,
  ConfigProvider,
  Deferred,
  Duration,
  Effect,
  Ref,
  Schedule,
  Schema as S,
} from "effect";
import { DaemonSessions, DaemonSessionsError } from "../daemon-sessions.ts";
import { errorMessage } from "../error-message.ts";
import { daemonSessionsFromCapabilitiesSocket } from "./daemon-sessions-layer.ts";
import { runPluginHostMain } from "./main.ts";
import { PluginHostRpcs, type PluginHostHandlers } from "./rpc.ts";

class CaptureFixtureError extends S.TaggedError<CaptureFixtureError>()("CaptureFixtureError", {
  message: S.String,
}) {}

const writeOut = (outPath: string, body: string): Effect.Effect<void, CaptureFixtureError> =>
  Effect.tryPromise({
    try: () => Bun.write(outPath, body),
    catch: (error) => new CaptureFixtureError({ message: errorMessage(error) }),
  }).pipe(Effect.asVoid);

const captureOnce = (
  outPath: string,
  session: string,
  expect: string,
): Effect.Effect<void, CaptureFixtureError | DaemonSessionsError | Config.ConfigError> =>
  Effect.gen(function* () {
    const capSocket = yield* Config.string("AMUX_PLUGIN_CAPABILITIES_SOCKET");
    const text = yield* Effect.gen(function* () {
      const sessions = yield* DaemonSessions;
      const screen = yield* sessions.capture(session);
      if (!screen.includes(expect)) {
        return yield* new DaemonSessionsError({
          message: `capture missing ${expect}`,
        });
      }
      return screen;
    }).pipe(
      Effect.provide(daemonSessionsFromCapabilitiesSocket(capSocket)),
      Effect.retry(
        Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: Duration.seconds(20) })),
      ),
    );
    yield* writeOut(outPath, text);
  }).pipe(Effect.catch((error) => writeOut(outPath, `error: ${errorMessage(error)}`)));

const captureHandlers = (stopped: Deferred.Deferred<void>): PluginHostHandlers => {
  const started = Ref.makeUnsafe(false);
  return PluginHostRpcs.toLayer({
    Ping: () =>
      Effect.gen(function* () {
        const already = yield* Ref.getAndSet(started, true);
        if (already) return;
        const outPath = process.argv[2];
        const session = process.argv[3];
        const expect = process.argv[4];
        if (outPath === undefined || session === undefined || expect === undefined) {
          return yield* Effect.die("capture-fixture argv: <outPath> <sessionId> <expectText>");
        }
        yield* Effect.forkDetach(
          captureOnce(outPath, session, expect).pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
          ),
        );
      }),
    Stop: () => Effect.forkDetach(Deferred.succeed(stopped, undefined)).pipe(Effect.asVoid),
  });
};

if (import.meta.main) {
  runPluginHostMain(captureHandlers);
}
