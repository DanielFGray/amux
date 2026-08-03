import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"

import { startDaemon } from "./daemon.ts"

/**
 * The daemon process.
 *
 * Same shape as the client in main.tsx: the daemon is a scoped resource and the
 * program parks forever, so the only way out is an interrupt — and an interrupt
 * runs `stop()` as a finalizer rather than as a signal handler racing
 * process.exit. That matters here more than in the client, because stop() is
 * what removes the socket, the lease and the lock; losing that race leaves a
 * session that every later client refuses to attach to.
 */
const program = Effect.gen(function* () {
  const daemon = yield* Effect.acquireRelease(
    Effect.promise(() => startDaemon()),
    (daemon) => Effect.promise(() => daemon.stop()).pipe(Effect.ignore),
  )
  yield* Effect.promise(() => daemon.stopped)
})

BunRuntime.runMain(Effect.scoped(program))
