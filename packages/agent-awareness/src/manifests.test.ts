import { expect } from "bun:test";
import { tmpdir } from "node:os";
import { testEffect } from "@danielfgray/amux/testing";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Effect, Layer } from "effect";
import { AgentManifests, buildRegistry } from "./manifests.ts";

const mkdtemp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ directory: tmpdir(), prefix: "amux-manifests-" });
});

interface ManifestFixture {
  readonly id: string;
  readonly version: string;
  readonly min_engine_version: number;
  readonly executables: readonly string[];
  readonly rules: readonly unknown[];
}

const writeOverride = Effect.fnUntraced(function* (
  configHome: string,
  name: string,
  data: ManifestFixture,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(configHome, "amux", "agent-detection");
  yield* fs.makeDirectory(dir, { recursive: true });
  // @effect-diagnostics-next-line preferSchemaOverJson:off -- `data` is already a typed fixture, not an unknown-shape read.
  yield* fs.writeFileString(path.join(dir, name), JSON.stringify(data));
});

const { live } = testEffect(BunFileSystem.layer.pipe(Layer.provideMerge(BunPath.layer)));

live("bundled manifests cover the known agent executables", () =>
  Effect.sync(() => {
    expect(AgentManifests.identifyAgent("claude")).toBe("claude");
    expect(AgentManifests.identifyAgent("codex")).toBe("codex");
    expect(AgentManifests.identifyAgent("nvim")).toBe(null);
  }),
);

live("a local file replaces a bundled manifest wholesale, by filename === id", () =>
  Effect.gen(function* () {
    const configHome = yield* mkdtemp;
    yield* writeOverride(configHome, "claude.json", {
      id: "claude",
      version: "1",
      min_engine_version: 1,
      executables: ["claude", "claude-code", "claude-custom"],
      rules: [],
    });
    const registry = buildRegistry(configHome);
    expect(registry.identifyAgent("claude-custom")).toBe("claude");
    // The replacement's rules are empty, so evaluation must fall back to the
    // "default" manifest's rules rather than keep the bundled claude rules.
    expect(registry.adapterFor("claude").id).toBe("default");
  }),
);

live("a local file can add a new agent the bundle does not know", () =>
  Effect.gen(function* () {
    const configHome = yield* mkdtemp;
    yield* writeOverride(configHome, "acme.json", {
      id: "acme",
      version: "1",
      min_engine_version: 1,
      executables: ["acme-cli"],
      rules: [],
    });
    const registry = buildRegistry(configHome);
    expect(registry.identifyAgent("acme-cli")).toBe("acme");
  }),
);

live("an agent with no custom rules falls back to the default adapter's rules", () =>
  Effect.sync(() => {
    expect(AgentManifests.adapterFor("gemini").id).toBe("default");
    expect(AgentManifests.adapterFor("claude").id).toBe("claude");
  }),
);

live("a malformed or mismatched-id local file is ignored, bundled data wins", () =>
  Effect.gen(function* () {
    const configHome = yield* mkdtemp;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(configHome, "amux", "agent-detection");
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "claude.json"), "{not json");
    yield* writeOverride(configHome, "codex.json", {
      id: "not-codex",
      version: "1",
      min_engine_version: 1,
      executables: [],
      rules: [],
    });
    const registry = buildRegistry(configHome);
    expect(registry.identifyAgent("claude")).toBe("claude");
    expect(registry.identifyAgent("codex")).toBe("codex");
  }),
);
