import { createCliRenderer, BoxRenderable } from "@opentui/core";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path computation, not I/O.
import { dirname } from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous by necessity; see installFrameProbe's doc comment.
import { writeFileSync } from "node:fs";
import { render } from "@opentui/solid";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { Schema as S, Config, ConfigProvider, Deferred, Effect, Exit, Layer, Option } from "effect";

class SessionIdError extends S.TaggedError<SessionIdError>()("SessionIdError", {
  message: S.String,
}) {}

import { loadConfig } from "./config.ts";
import { configPath } from "./config.ts";
import { SessionClient } from "./client.ts";
import { isSessionId, optionalEnvVar, SessionStore } from "./session.ts";

/**
 * Wall-clock origin for AMUX_STARTUP_PROBE marks.
 * Prefer a --preload stamp so import graph cost is visible; fall back to this
 * module's evaluation time (post-import).
 */
const STARTUP_T0 =
  (globalThis as { __amuxStartupT0?: number }).__amuxStartupT0 ?? performance.now();
const startupMarks = new Map<string, number>([["module_body", performance.now() - STARTUP_T0]]);

/**
 * Sync config read at bootstrap. Cite: effect Config is an Effect with
 * `.parse(provider)` (effect-v4 Config.ts); `ConfigProvider.fromEnv` is the
 * default Reference — call it explicitly so each probe sees a fresh env
 * snapshot rather than the process-lifetime default capture.
 */
function readConfig<A>(config: Config.Config<A>): A {
  return Effect.runSync(config.parse(ConfigProvider.fromEnv()));
}

function probeFlag(name: string): boolean {
  return readConfig(Config.boolean(name).pipe(Config.withDefault(false)));
}

function startupMark(name: string): void {
  if (!probeFlag("AMUX_STARTUP_PROBE")) return;
  startupMarks.set(name, performance.now() - STARTUP_T0);
}

function flushStartupProbe(): void {
  if (!probeFlag("AMUX_STARTUP_PROBE")) return;
  const path = readConfig(
    Config.string("AMUX_STARTUP_PROBE_PATH").pipe(
      Config.withDefault(`/tmp/amux-startup-probe-${process.pid}.json`),
    ),
  );
  writeFileSync(path, JSON.stringify(Object.fromEntries(startupMarks), null, 2) + "\n");
}

startupMark("imports_done");

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
 *
 * Startup concurrency: `app.tsx` is the heavy module graph. Loading it in
 * parallel with config, renderer creation, and `SessionClient.connect` lets a
 * cold daemon spawn overlap the UI import instead of paying both in series.
 */
const program = Effect.gen(function* () {
  startupMark("program_enter");

  const SESSION_ID = Option.getOrElse(yield* optionalEnvVar("AMUX_SESSION"), () => "default");
  if (!isSessionId(SESSION_ID)) {
    return yield* new SessionIdError({
      message: `invalid AMUX_SESSION "${SESSION_ID}"`,
    });
  }

  const [config, renderer, session, { createApp }] = yield* Effect.all(
    [
      loadConfig().pipe(Effect.tap(() => Effect.sync(() => startupMark("config_loaded")))),
      Effect.acquireRelease(
        Effect.promise(() =>
          createCliRenderer({
            exitOnCtrlC: false,
            targetFps: 60,
            useMouse: true,
            exitSignals: [],
          }),
        ),
        (r) => Effect.sync(() => r.destroy()),
      ).pipe(Effect.tap(() => Effect.sync(() => startupMark("renderer_ready")))),
      // The client closes its attach and control sockets with the enclosing scope.
      SessionClient.connect(SESSION_ID).pipe(
        Effect.tap(() => Effect.sync(() => startupMark("session_connected"))),
      ),
      Effect.promise(() => import("./app.tsx")).pipe(
        Effect.tap(() => Effect.sync(() => startupMark("app_module_loaded"))),
      ),
    ],
    { concurrency: "unbounded" },
  );

  installFrameProbe(renderer);
  renderer.useKittyKeyboard = false;

  const paneHost = new BoxRenderable(renderer, {
    id: "pane-host",
    flexDirection: "row",
    flexGrow: 1,
  });

  const quit = yield* Deferred.make<void>();

  const app = yield* createApp({
    renderer,
    paneHost,
    config,
    configDir: dirname(yield* configPath),
    session,
    quit: () => Deferred.doneUnsafe(quit, Exit.void),
  });
  startupMark("app_created");
  yield* Effect.promise(() => render(app.View, renderer));
  startupMark("first_render");
  flushStartupProbe();
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
  if (!probeFlag("AMUX_FRAME_PROBE")) return;

  const path = `/tmp/amux-frame-probe-${process.pid}.json`;
  const counts: { [status: string]: number } = {};
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
    Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
  ),
);
