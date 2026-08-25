import { createCliRenderer, BoxRenderable } from "@opentui/core";
import { dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { render } from "@opentui/solid";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { Schema as S, Deferred, Effect, Exit } from "effect";

class SessionIdError extends S.TaggedError<SessionIdError>()("SessionIdError", {
  message: S.String,
}) {}

import { loadConfig } from "./config.ts";
import { CONFIG_PATH } from "./config.ts";
import { applyOptions, resolveOptions } from "./options.ts";
import { SessionClient } from "./client.ts";
import { isSessionId, SessionStore } from "./session.ts";
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
  installFrameProbe(renderer);
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

  // The client closes its attach and control sockets with the enclosing scope.
  const session = yield* SessionClient.connect(SESSION_ID);

  const quit = yield* Deferred.make<void>();

  const app = yield* createApp({
    renderer,
    paneHost,
    config,
    configDir: dirname(CONFIG_PATH),
    session,
    quit: () => Deferred.unsafeDone(quit, Exit.void),
  });
  yield* Effect.promise(() => render(app.View, renderer));
  yield* Deferred.await(quit);
});

/**
 * Counts the outcome of every native frame flush, when AMUX_FRAME_PROBE=1.
 *
 * OpenTUI drops a frame and reschedules for three of its four rejection
 * statuses. The fourth, "failed", clears the render timeout and schedules
 * nothing, so the screen stays stale until unrelated input revives the loop.
 * amux can only ever reach that one: it renders to process.stdout, so it has no
 * NativeSpanFeed, and OpenTUI forces useThread=false on Linux — which is the
 * pair of conditions that routes a skipped frame past the "backpressured"
 * branch and into "failed". The two console.error calls on that path go to
 * OpenTUI's own TerminalConsole, invisible inside a running TUI, so the stall
 * reports itself nowhere. Hence a probe that writes outside the terminal.
 *
 * Three constraints shape the writing, and each one cost a run to learn:
 *
 * The steady state must add no syscalls. Flushing per frame puts a synchronous
 * write in the render loop at 60fps, which slows the producer, spaces out the
 * output, and suppresses the rejection being hunted — the probe would hide its
 * own quarry. Counts stay in memory instead.
 *
 * A rejection writes immediately rather than at exit, because a probe run
 * usually ends by killing the pane, and an exit handler never fires. Writing on
 * the spot makes an absent file a real result: no file means no rejection, not
 * a lost run.
 *
 * The write is synchronous node:fs rather than the platform FileSystem the rest
 * of the codebase uses. This runs inside a monkey-patched render callback that
 * must return a status synchronously; there is no Effect to run it in.
 */
function installFrameProbe(renderer: import("@opentui/core").CliRenderer): void {
  if (process.env.AMUX_FRAME_PROBE !== "1") return;

  const path = `/tmp/amux-frame-probe-${process.pid}.json`;
  const counts: Record<string, number> = {};
  let dirty = true;
  const renderNative = (Reflect.get(renderer, "renderNative") as () => string | undefined).bind(
    renderer,
  );
  const write = () => {
    if (!dirty) return;
    writeFileSync(path, JSON.stringify({ pid: process.pid, counts }, null, 2) + "\n");
    dirty = false;
  };

  Reflect.set(renderer, "renderNative", () => {
    const status = renderNative() ?? "rendered";
    counts[status] = (counts[status] ?? 0) + 1;
    dirty = true;
    if (status !== "rendered") write();
    return status;
  });
  process.on("exit", write);
  process.stdout.write(`AMUX frame probe: ${path}\n`);
}

BunRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(SessionStore.Default),
    Effect.provide(BunFileSystem.layer),
  ),
);
