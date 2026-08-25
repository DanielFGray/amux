import { Command, FileSystem } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";

const root = process.cwd();
const build = `${root}/build`;

class BuildCommandError extends S.TaggedError<BuildCommandError>()("BuildCommandError", {
  command: S.String,
  exitCode: S.Number,
}) {}

const run = (command: Command.Command) =>
  Effect.gen(function* () {
    const exitCode = yield* Command.exitCode(command);
    if (exitCode !== 0) {
      return yield* new BuildCommandError({
        command: Command.flatten(command)
          .map(({ command: executable }) => executable)
          .join(" | "),
        exitCode,
      });
    }
  });

const compile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.makeDirectory(build, { recursive: true });
  yield* fs.copy(`${root}/vendor/libamux-shim.so`, `${build}/libamux-shim.so`, { overwrite: true });
  yield* fs.copy(`${root}/vendor/libghostty-vt/zig-out/lib`, `${build}/libghostty-vt/zig-out/lib`, {
    overwrite: true,
  });

  yield* run(
    Command.make(
      "bun",
      "build",
      "--compile",
      "--no-compile-autoload-bunfig",
      `${root}/src/cli.ts`,
      "--outfile",
      `${build}/amux`,
    ).pipe(Command.workingDirectory(root), Command.stdout("inherit"), Command.stderr("inherit")),
  );

  yield* Effect.log("Run with: cd build && ./amux");
});

compile.pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
