import { createCliRenderer, BoxRenderable } from "@opentui/core";
import { render } from "@opentui/solid";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { Data, Deferred, Effect, Exit } from "effect";

class SessionIdError extends Data.TaggedError("SessionIdError")<{ message: string }> {}

import { loadConfig } from "./config.ts";
import { applyOptions, resolveOptions } from "./options.ts";
import { SessionClient } from "./client.ts";
import { isSessionId, Session, SessionEnv } from "./session.ts";
import { createApp } from "./app.tsx";

/**
 * The entry point, and the only place in the client that owns a lifetime.
 *
 * Every resource is acquired with a release attached, so there is exactly one
 * teardown path and it runs in reverse order on every way out: ^a q, the last
 * space closing, a SIGTERM, or a defect. That last one is the point of the
 * phase — the old code installed signal handlers that could only close the
 * socket and call process.exit, and said so in a comment: there was no time to
 * preserve layout. The daemon now persists every authoritative model revision,
 * so client teardown has no workspace snapshot to race or flush.
 *
 * The Deferred is not ceremony. `render` from @opentui/solid resolves after
 * MOUNT, not on exit, so awaiting it would return immediately and close the
 * scope out from under a live app. The program parks on `quit` instead, and the
 * app asks to leave by completing it.
 */
const program = Effect.gen(function* () {
  const config = yield* Effect.promise(() => loadConfig());
  applyOptions(resolveOptions(config.options));

  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 60,
        useMouse: true,
        exitSignals: [],
      }),
    ),
    (r) => Effect.sync(() => r.destroy()),
  );
  renderer.useKittyKeyboard = false;

  const paneHost = new BoxRenderable(renderer, {
    id: "pane-host",
    flexDirection: "row",
    flexGrow: 1,
  });

  const SESSION_ID = process.env.AMUX_SESSION || "default";
  if (!isSessionId(SESSION_ID)) {
    return yield* new SessionIdError({
      message: `invalid AMUX_SESSION ${JSON.stringify(SESSION_ID)}`,
    });
  }

  const session = yield* Effect.acquireRelease(SessionClient.connect(SESSION_ID), (s) =>
    Effect.sync(() => s.attach.close()),
  );

  const quit = yield* Deferred.make<void>();

  const app = yield* createApp({
    renderer,
    paneHost,
    config,
    session,
    quit: () => Deferred.unsafeDone(quit, Exit.void),
  });
  yield* Effect.promise(() => render(app.View, renderer));
  yield* Deferred.await(quit);
});

BunRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.provide(Session.Default),
    Effect.provide(BunFileSystem.layer),
    Effect.provideService(SessionEnv, process.env),
  ),
);
