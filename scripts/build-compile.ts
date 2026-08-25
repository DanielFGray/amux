import { FileSystem } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import solidPlugin from "@opentui/solid/bun-plugin";

const root = process.cwd();
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
  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [`${root}/src/cli.ts`],
        target: "bun",
        plugins: [solidPlugin],
        // The standalone executable has no bunfig.toml embedded in it, so
        // letting it autoload one at startup means it tries (and fails) to
        // resolve bunfig's `preload` entries from outside the bundle.
        compile: { outfile: `${build}/amux`, autoloadBunfig: false },
      }),
    catch: (cause) => new BuildBundleError({ logs: [cause] }),
  });

  if (!result.success) {
    return yield* new BuildBundleError({ logs: result.logs });
  }

  yield* Effect.log("Run with: cd build && ./amux");
});

compile.pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
