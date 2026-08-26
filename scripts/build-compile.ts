import { Duration, Effect, Schema as S } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import solidPlugin from "@opentui/solid/bun-plugin";

const root = process.cwd();
const app = `${root}/packages/amux`;
const build = `${root}/build`;

class BuildBundleError extends S.TaggedError<BuildBundleError>()("BuildBundleError", {
  logs: S.Array(S.Unknown),
}) {}

const compile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.makeDirectory(build, { recursive: true });
  yield* fs.copy(`${root}/vendor/libamux-shim.so`, `${build}/libamux-shim.so`, { overwrite: true });
  yield* fs.copy(`${root}/vendor/libghostty-vt/zig-out/lib`, `${build}/libghostty-vt/zig-out/lib`, {
    overwrite: true,
  });

  // @opentui/solid ships dist/server.js under solid-js's "node" export
  // condition; its bun-plugin rewrites those loads to the client build.
  // bunfig.toml's preload registers that plugin for `bun run`/`bun test`,
  // but Bun.build() (and the `bun build` CLI) never consult bunfig
  // preloads, so the plugin must be passed explicitly here.
  yield* Effect.logInfo("Compiling amux CLI bundle...");
  const [duration, result] = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [`${app}/src/cli.ts`],
        target: "bun",
        plugins: [solidPlugin],
        // The standalone executable has no bunfig.toml embedded in it, so
        // letting it autoload one at startup means it tries (and fails) to
        // resolve bunfig's `preload` entries from outside the bundle.
        compile: { outfile: `${build}/amux`, autoloadBunfig: false },
      }),
    catch: (cause) => new BuildBundleError({ logs: [cause] }),
  }).pipe(Effect.timed);

  if (!result.success) {
    return yield* new BuildBundleError({ logs: result.logs });
  }

  // pty-reader.worker.ts is reached only via `new Worker(new URL(...))` in
  // src/pty.ts — a dynamic reference the standalone-executable compile step
  // above does not trace, and bundling it as a second entrypoint of that
  // same compile corrupts the daemon's process lifetime (it sets
  // `globalThis.onmessage` at module scope, which — bundled into the same
  // module graph as cli.ts — makes the compiled process's main thread look
  // like an idle worker to Bun's own exit-when-idle logic, and it exits
  // immediately instead of serving the daemon). Building it as its own
  // separate, ordinary output file sidesteps that: it shares no module graph
  // with cli.ts, and `readPty` in src/pty.ts checks for this sibling file
  // next to the running executable before falling back to the dev-mode path.
  const workerResult = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [`${app}/src/pty-reader.worker.ts`],
        target: "bun",
        outdir: build,
        naming: "pty-reader.worker.js",
      }),
    catch: (cause) => new BuildBundleError({ logs: [cause] }),
  });
  if (!workerResult.success) {
    return yield* new BuildBundleError({ logs: workerResult.logs });
  }

  yield* Effect.logInfo(`Done in ${Duration.format(duration)}`);
});

compile.pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
