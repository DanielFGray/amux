import { expect } from "bun:test";
import { Effect, Layer, Path } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { fileURLToPath } from "node:url";
import {
  decodeProcessPluginManifest,
  loadProcessPluginManifest,
  PROCESS_PLUGIN_MANIFEST_FILES,
  PROCESS_PLUGIN_MANIFEST_JSON,
  PROCESS_PLUGIN_MANIFEST_TOML,
} from "./manifest.ts";
import { testEffect } from "../test-effect.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const layers = Layer.mergeAll(BunFileSystem.layer, Path.layer);

testEffect("decodes a minimal process-plugin manifest", () =>
  Effect.gen(function* () {
    const manifest = yield* decodeProcessPluginManifest({
      id: "example.tools",
      name: "Tools",
      version: "0.1.0",
      actions: [{ id: "hello", title: "Hello", command: ["echo", "hi"] }],
      panes: [{ id: "board", title: "Board", command: ["htop"] }],
    });
    expect(manifest.id).toBe("example.tools");
    expect(manifest.actions).toHaveLength(1);
    expect(manifest.panes[0]?.command).toEqual(["htop"]);
  }),
);

testEffect("rejects duplicate action ids", () =>
  Effect.gen(function* () {
    const result = yield* decodeProcessPluginManifest({
      id: "example.tools",
      name: "Tools",
      version: "0.1.0",
      actions: [
        { id: "hello", title: "A", command: ["true"] },
        { id: "hello", title: "B", command: ["true"] },
      ],
    }).pipe(Effect.exit);
    expect(result._tag).toBe("Failure");
  }),
);

testEffect("rejects dotted entrypoint ids", () =>
  Effect.gen(function* () {
    const result = yield* decodeProcessPluginManifest({
      id: "example.tools",
      name: "Tools",
      version: "0.1.0",
      panes: [{ id: "my.pane", title: "Board", command: ["htop"] }],
    }).pipe(Effect.exit);
    expect(result._tag).toBe("Failure");
  }),
);

testEffect("defaults pane placement to tiled and accepts floating+transient", () =>
  Effect.gen(function* () {
    const bare = yield* decodeProcessPluginManifest({
      id: "example.tools",
      name: "Tools",
      version: "0.1.0",
      panes: [{ id: "board", title: "Board", command: ["htop"] }],
    });
    expect(bare.panes[0]?.placement).toBe("tiled");
    expect(bare.panes[0]?.transient).toBe(false);

    const floating = yield* decodeProcessPluginManifest({
      id: "example.tools",
      name: "Tools",
      version: "0.1.0",
      panes: [
        {
          id: "picker",
          title: "Picker",
          command: ["fzf"],
          placement: "floating",
          transient: true,
        },
      ],
    });
    expect(floating.panes[0]?.placement).toBe("floating");
    expect(floating.panes[0]?.transient).toBe(true);
  }),
);

testEffect("defaults startup to empty and decodes [[startup]] argv", () =>
  Effect.gen(function* () {
    const bare = yield* decodeProcessPluginManifest({
      id: "example.tools",
      name: "Tools",
      version: "0.1.0",
    });
    expect(bare.startup).toEqual([]);

    const withStartup = yield* decodeProcessPluginManifest({
      id: "example.tools",
      name: "Tools",
      version: "0.1.0",
      startup: [{ command: ["bun", "run", "auto-title.ts"] }],
    });
    expect(withStartup.startup).toEqual([{ command: ["bun", "run", "auto-title.ts"] }]);
  }),
);

testEffect("accepts json and toml filenames", () =>
  Effect.sync(() => {
    expect(PROCESS_PLUGIN_MANIFEST_FILES).toEqual([
      PROCESS_PLUGIN_MANIFEST_JSON,
      PROCESS_PLUGIN_MANIFEST_TOML,
    ]);
  }),
);

testEffect("loads amux-plugin.json and amux-plugin.toml", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      directory: testDir,
      prefix: ".test-manifest-formats-",
    });

    const jsonRoot = path.join(root, "json-plugin");
    yield* fs.makeDirectory(jsonRoot, { recursive: true });
    yield* fs.writeFileString(
      path.join(jsonRoot, PROCESS_PLUGIN_MANIFEST_JSON),
      JSON.stringify({
        id: "example.json",
        name: "Json",
        version: "0.1.0",
        actions: [{ id: "ping", title: "Ping", command: ["true"] }],
      }),
    );
    expect((yield* loadProcessPluginManifest(jsonRoot)).id).toBe("example.json");

    const tomlRoot = path.join(root, "toml-plugin");
    yield* fs.makeDirectory(tomlRoot, { recursive: true });
    yield* fs.writeFileString(
      path.join(tomlRoot, PROCESS_PLUGIN_MANIFEST_TOML),
      [
        'id = "example.toml"',
        'name = "Toml"',
        'version = "0.1.0"',
        "",
        "[[actions]]",
        'id = "ping"',
        'title = "Ping"',
        'command = ["true"]',
        "",
      ].join("\n"),
    );
    expect((yield* loadProcessPluginManifest(tomlRoot)).id).toBe("example.toml");

    const bothRoot = path.join(root, "both-plugin");
    yield* fs.makeDirectory(bothRoot, { recursive: true });
    yield* fs.writeFileString(
      path.join(bothRoot, PROCESS_PLUGIN_MANIFEST_JSON),
      JSON.stringify({ id: "example.both", name: "Both", version: "0.1.0" }),
    );
    yield* fs.writeFileString(
      path.join(bothRoot, PROCESS_PLUGIN_MANIFEST_TOML),
      'id = "example.both"\nname = "Both"\nversion = "0.1.0"\n',
    );
    const ambiguous = yield* loadProcessPluginManifest(bothRoot).pipe(Effect.exit);
    expect(ambiguous._tag).toBe("Failure");
    if (ambiguous._tag === "Failure") {
      expect(String(ambiguous.cause)).toContain("ambiguous");
    }
  }).pipe(Effect.provide(layers)),
);
