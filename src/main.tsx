import { createCliRenderer, BoxRenderable } from "@opentui/core"
import { render } from "@opentui/solid"
import { BunRuntime } from "@effect/platform-bun"
import { Deferred, Effect, Exit } from "effect"

import { loadConfig, applyConfig } from "./config.ts"
import { SessionClient } from "./client.ts"
import { isSessionId, SessionEnv } from "./session.ts"
import { createApp } from "./app.tsx"

/**
 * The entry point, and the only place in the client that owns a lifetime.
 *
 * Every resource is acquired with a release attached, so there is exactly one
 * teardown path and it runs in reverse order on every way out: ^a q, the last
 * space closing, a SIGTERM, or a defect. That last one is the point of the
 * phase — the old code installed signal handlers that could only close the
 * socket and call process.exit, and said so in a comment: there was no time to
 * save. There is now, because the finalizer that saves is the same one a normal
 * exit runs.
 *
 * The Deferred is not ceremony. `render` from @opentui/solid resolves after
 * MOUNT, not on exit, so awaiting it would return immediately and close the
 * scope out from under a live app. The program parks on `quit` instead, and the
 * app asks to leave by completing it.
 */
const program = Effect.gen(function* () {
  const config = yield* Effect.promise(() => loadConfig())
  // Push the loaded values into the copy imperative code reads.
  applyConfig(config)

  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 60,
        useMouse: true,
        // Take the renderer's own signal handling away from it. By default it
        // installs listeners on SIGINT/SIGTERM/SIGQUIT/SIGABRT/SIGHUP/... that
        // call destroy() the moment a signal lands, which tears the renderable
        // tree down before anything else can read it — and the workspace is
        // read OUT of that tree. Measured: a SIGTERM with these left in place
        // saves the session with `root: null`, having thrown away the very
        // arrangement it exists to record.
        //
        // Nothing is lost by disabling them: their handler is exactly the
        // destroy() below, and BunRuntime.runMain turns the same signals into
        // an interrupt, which runs it in the right order instead of first.
        exitSignals: [],
      }),
    ),
    (r) => Effect.sync(() => r.destroy()),
  )
  // Raw key passthrough needs the OUTER terminal to keep emitting classic escape
  // sequences — the children speak xterm-256color terminfo and would misparse the
  // CSI-u forms a kitty-enabled host produces.
  renderer.useKittyKeyboard = false

  // The imperative half: split trees of cell-blitting panes. Solid adopts this
  // box as a child but never reconciles inside it.
  const paneHost = new BoxRenderable(renderer, {
    id: "pane-host",
    flexDirection: "row",
    flexGrow: 1,
  })

  /**
   * The session this client is a view of.
   *
   * The processes are not ours. They belong to a daemon that is started on demand
   * and outlives us, which is what makes closing this terminal a detach rather
   * than a massacre — and what makes running the program again put the same
   * agents back on screen, still running, rather than re-running their commands.
   *
   * Everything downstream is unchanged by that: agents get their bytes from a
   * SpawnBackend, and whether that backend is a local PTY or a socket to the
   * daemon is a fact none of the UI knows or asks.
   */
  const SESSION_ID = process.env.HERDR_SESSION || "default"
  if (!isSessionId(SESSION_ID)) {
    // Fail before anything touches the filesystem; the id becomes a directory
    // name under the sessions root, and an unvalidated one could escape it.
    return yield* Effect.fail(new Error(`invalid HERDR_SESSION ${JSON.stringify(SESSION_ID)}`))
  }

  /**
   * Set once the app exists, so the session's finalizer can record the
   * workspace before dropping the socket.
   *
   * A nullable hole rather than a reference to `app` below, because the session
   * is acquired first and must be released last: if createApp throws, this
   * finalizer still runs, and reaching for a binding that was never initialised
   * would turn a startup failure into a defect during teardown.
   */
  let persist: (() => Promise<void>) | null = null

  const session = yield* Effect.acquireRelease(
    SessionClient.connect(SESSION_ID),
    // Detach, never kill: record where the workspace got to, then drop the
    // socket. The daemon keeps the agents running either way, so a failed save
    // must not stop us letting go of the connection.
    (s) =>
      Effect.gen(function* () {
        if (persist) yield* Effect.promise(persist).pipe(Effect.ignore)
        yield* Effect.sync(() => s.attach.close())
      }),
  )

  const quit = yield* Deferred.make<void>()

  const app = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createApp({
        renderer,
        paneHost,
        config,
        session,
        quit: () => Deferred.unsafeDone(quit, Exit.void),
      }),
    ),
    (a) => Effect.sync(() => a.dispose()),
  )
  persist = app.persist

  yield* Effect.promise(() => render(app.View, renderer))
  yield* Deferred.await(quit)
})

BunRuntime.runMain(Effect.scoped(program).pipe(Effect.provideService(SessionEnv, process.env)))
