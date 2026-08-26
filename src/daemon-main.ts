import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

import { startDaemon } from "./daemon.ts";
import { SessionStore } from "./session.ts";

/**
 * The daemon process.
 *
 * Same shape as the client in main.tsx: the daemon is a scoped resource and the
 * program parks forever, so the only way out is an interrupt — and an interrupt
 * runs the shutdown as a finalizer rather than as a signal handler racing
 * process.exit. That matters here more than in the client, because shutdown is
 * what removes the socket, the lease and the lock; losing that race leaves a
 * session that every later client refuses to attach to.
 *
 * It closes rather than stops. A signal says the process must go, never that
 * the session should; a reboot or an OOM kill would otherwise delete the very
 * layout and agent-event logs the session persists in order to come back.
 */
export function runDaemonMain(id?: string): void {
  const program = Effect.gen(function* () {
    // Not `acquireRelease`: its acquire is uninterruptible, and binding the
    // control socket races the listen against the server's error signal —
    // a race that can never be decided where interruption is disabled.
    // `startDaemon` already unwinds its own partial state on failure.
    const daemon = yield* startDaemon(id);
    yield* Effect.addFinalizer(() => daemon.close.pipe(Effect.ignore));
    yield* daemon.closed;
  });

  BunRuntime.runMain(
    Effect.scoped(program).pipe(
      Effect.provide(SessionStore.Default),
      Effect.provide(BunFileSystem.layer),
    ),
  );
}

if (import.meta.main) {
  // The e2e lifecycle test uses this barrier to signal after spawn but before
  // the daemon creates its lease. Normal daemon launches never set it.
  const barrier = process.env.AMUX_DAEMON_START_BARRIER;
  if (barrier) {
    const waitForBarrier = async () => {
      while (!(await Bun.file(barrier).exists())) await Bun.sleep(10);
    };
    await waitForBarrier();
  }
  runDaemonMain(process.argv[2]);
}
