import { expect } from "bun:test";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { DateTime, Effect, Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { initialContext, instructionFiles } from "./context.ts";
import { testEffect } from "@danielfgray/amux/testing";

const it = testEffect(Layer.mergeAll(BunFileSystem.layer, Path.layer));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "amux-context-" });
  yield* Effect.addFinalizer(() =>
    fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore),
  );
  const workspace = path.join(root, "project");
  const config = path.join(root, "config");
  yield* fs.makeDirectory(path.join(workspace, "src"), { recursive: true });
  yield* fs.makeDirectory(config, { recursive: true });
  return { fs, path, workspace, config };
});

it.effect("initial context includes stable environment facts", () =>
  Effect.gen(function* () {
    const { workspace, config } = yield* fixture;
    const context = yield* initialContext({
      workspace,
      configDirectory: config,
      platform: "linux",
      now: DateTime.toDate(DateTime.makeUnsafe("2026-08-12T13:00:00Z")),
    });
    expect(context).toContain("Workspace: " + workspace);
    expect(context).toContain("Platform: linux");
    expect(context).toContain("Date: 2026-08-12");
  }),
);

it.effect("global instructions precede project instructions and empty files are ignored", () =>
  Effect.gen(function* () {
    const { fs, path, workspace, config } = yield* fixture;
    yield* fs.writeFileString(path.join(config, "AGENTS.md"), "global rules\n");
    yield* fs.writeFileString(path.join(workspace, "AGENTS.md"), "project rules\n");
    yield* fs.writeFileString(path.join(workspace, "CLAUDE.md"), "\n");
    expect(yield* instructionFiles({ workspace, configDirectory: config })).toEqual([
      `Instructions from: ${path.join(config, "AGENTS.md")}\nglobal rules`,
      `Instructions from: ${path.join(workspace, "AGENTS.md")}\nproject rules`,
    ]);
  }),
);

it.effect("ancestor instructions precede files nearer the active directory", () =>
  Effect.gen(function* () {
    const { fs, path, workspace, config } = yield* fixture;
    const nested = path.join(workspace, "src");
    yield* fs.writeFileString(path.join(workspace, "AGENTS.md"), "root rules\n");
    yield* fs.writeFileString(path.join(nested, "CLAUDE.md"), "nested rules\n");
    expect(yield* instructionFiles({ workspace: nested, configDirectory: config })).toEqual(
      expect.arrayContaining([
        `Instructions from: ${path.join(workspace, "AGENTS.md")}\nroot rules`,
        `Instructions from: ${path.join(nested, "CLAUDE.md")}\nnested rules`,
      ]),
    );
  }),
);
