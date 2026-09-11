import { expect } from "bun:test";
import { Effect, Exit, Layer, Path, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem, BunServices } from "@effect/platform-bun";
import { fileURLToPath } from "node:url";
import { PROCESS_PLUGIN_MANIFEST } from "./manifest.ts";
import { linkProcessPlugin } from "./registry.ts";
import { runProcessPluginStartups } from "./startup.ts";
import { testEffect } from "../test-effect.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const layers = Layer.mergeAll(BunFileSystem.layer, Path.layer);

testEffect("runs [[startup]] and kills the child when the scope closes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      directory: testDir,
      prefix: ".test-process-startup-",
    });
    const pluginRoot = path.join(root, "startup-plugin");
    const marker = path.join(root, "started");
    yield* fs.makeDirectory(pluginRoot, { recursive: true });
    yield* fs.writeFileString(
      path.join(pluginRoot, PROCESS_PLUGIN_MANIFEST),
      [
        'id = "example.startup"',
        'name = "Startup"',
        'version = "0.1.0"',
        "",
        "[[startup]]",
        `command = ["sh", "-c", "touch '${marker}' && sleep 30"]`,
        "",
      ].join("\n"),
    );
    const roots = {
      registryPath: path.join(root, "registry.json"),
      configRoot: path.join(root, "config"),
      stateRoot: path.join(root, "state"),
    };
    yield* linkProcessPlugin(pluginRoot, { roots });

    const scope = yield* Scope.make();
    const logs: string[] = [];
    yield* runProcessPluginStartups({
      daemonSession: "test-session",
      controlSocket: path.join(root, "control.sock"),
      processStateSocket: path.join(root, "process-state.sock"),
      binPath: "/usr/bin/amux",
      roots,
      onLog: (message) => {
        logs.push(message);
      },
    }).pipe(Effect.provide(BunServices.layer), Scope.provide(scope));

    for (let i = 0; i < 50; i++) {
      if (yield* fs.exists(marker)) break;
      yield* Effect.sleep("20 millis");
    }
    expect(yield* fs.exists(marker)).toBe(true);
    expect(logs.some((line) => line.includes("startup[0]: pid="))).toBe(true);

    yield* Scope.close(scope, Exit.void);
    yield* Effect.sleep("50 millis");
  }).pipe(Effect.provide(layers)),
);
