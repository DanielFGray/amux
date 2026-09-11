import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect, test } from "bun:test";
import { testEffect } from "../../amux/src/test-effect.ts";
import {
  builtInCatalog,
  catalogWithOverrides,
  languageForPath,
  loadCatalogOverrides,
  serverCommandsFor,
  workspaceRoot,
} from "./catalog.ts";

const tests = testEffect(Layer.merge(BunFileSystem.layer, Path.layer));

test("maps TypeScript files to the built-in server candidate", () => {
  expect(Option.getOrUndefined(languageForPath(builtInCatalog, "/project/source.tsx"))).toBe(
    "typescript",
  );
  expect(
    Option.getOrUndefined(languageForPath(builtInCatalog, "/project/README.md")),
  ).toBeUndefined();
  expect(Option.getOrUndefined(serverCommandsFor(builtInCatalog, "typescript"))).toEqual([
    { command: "typescript-language-server", args: ["--stdio"] },
  ]);
});

tests.live(
  "loads per-user language definitions that replace built-in candidates",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "amux-lsp-catalog-" });
    yield* fs.writeFileString(
      `${configDirectory}/lsp.json`,
      `{
        "languages": {
          "typescript": {
            "extensions": [".ts", ".tsx"],
            "servers": [{ "command": "tsgo", "args": ["--lsp"] }]
          },
          "go": {
            "extensions": [".go"],
            "servers": [{ "command": "gopls", "args": [] }]
          }
        }
      }`,
    );
    const catalog = catalogWithOverrides(yield* loadCatalogOverrides(configDirectory));
    expect(Option.getOrUndefined(serverCommandsFor(catalog, "typescript"))).toEqual([
      { command: "tsgo", args: ["--lsp"] },
    ]);
    expect(Option.getOrUndefined(languageForPath(catalog, "/project/main.go"))).toBe("go");
  }),
);

tests.live(
  "uses the pane working directory as the resolved workspace root",
  Effect.gen(function* () {
    expect(yield* workspaceRoot(".")).toBe((yield* Path.Path).resolve("."));
  }),
);
