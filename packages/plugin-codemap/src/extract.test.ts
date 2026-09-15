/**
 * Extractor checks against real amux shapes (rg ground truth / LSP-check symbols).
 * Asserts the edges that matter — not whole-output snapshots.
 */
import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { treeSitterLayer } from "@danielfgray/amux-highlight";
import { testEffect } from "@danielfgray/amux/testing";
import { CodemapExtractor, layer as extractorLayer } from "./service.ts";
import {
  ExtractUnsupportedFiletype,
  type CodemapEdge,
  type CodemapSymbol,
  type FileExtraction,
} from "./schema.ts";

const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

const live = extractorLayer.pipe(
  Layer.provide(treeSitterLayer),
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer)),
);

/** Real clock: grammar load may touch disk / HTTP. */
const it = testEffect(live);

const hasSymbol = (
  extraction: FileExtraction,
  name: string,
  opts: { owner?: string; kind?: CodemapSymbol["kind"] } = {},
): boolean =>
  extraction.symbols.some(
    (s) =>
      s.name === name &&
      (opts.owner === undefined || s.owner === opts.owner) &&
      (opts.kind === undefined || s.kind === opts.kind),
  );

const callsFrom = (extraction: FileExtraction, sourceName: string): ReadonlyArray<CodemapEdge> => {
  const sources = new Set(extraction.symbols.filter((s) => s.name === sourceName).map((s) => s.id));
  return extraction.edges.filter((e) => e.relation === "calls" && sources.has(e.source));
};

const fileCallsTarget = (extraction: FileExtraction, target: string): boolean =>
  extraction.edges.some((e) => e.relation === "calls" && e.target === target);

const extractRel = (rel: string) =>
  Effect.gen(function* () {
    const extractor = yield* CodemapExtractor;
    return yield* extractor.extractPath(`${repoRoot}/${rel}`);
  });

it.live("makeDaemonService is a const from Effect.fnUntraced", () =>
  Effect.gen(function* () {
    const extraction = yield* extractRel("packages/amux/src/daemon.ts");
    expect(hasSymbol(extraction, "makeDaemonService", { kind: "const" })).toBe(true);
    const sym = extraction.symbols.find((s) => s.name === "makeDaemonService");
    expect(sym?.exported).toBe(true);
    expect(fileCallsTarget(extraction, "bindPluginBehaviour")).toBe(true);
  }),
);

it.live("loadPluginsEffect is indexed and called from loader wrappers", () =>
  Effect.gen(function* () {
    const extraction = yield* extractRel("packages/amux/src/plugin/loader.ts");
    expect(hasSymbol(extraction, "loadPluginsEffect", { kind: "const" })).toBe(true);
    expect(fileCallsTarget(extraction, "loadPluginsEffect")).toBe(true);
  }),
);

it.live("addPlugin nested in createPluginHost is a local symbol", () =>
  Effect.gen(function* () {
    const extraction = yield* extractRel("packages/amux/src/plugin/host.ts");
    expect(hasSymbol(extraction, "createPluginHost", { kind: "function" })).toBe(true);
    expect(hasSymbol(extraction, "addPlugin", { owner: "createPluginHost", kind: "const" })).toBe(
      true,
    );
    expect(fileCallsTarget(extraction, "addPlugin")).toBe(true);
  }),
);

it.live("WorkspaceTransaction.run is a Context.Service make method", () =>
  Effect.gen(function* () {
    const extraction = yield* extractRel("packages/amux/src/effect/WorkspaceTransaction.ts");
    expect(hasSymbol(extraction, "WorkspaceTransaction", { kind: "class" })).toBe(true);
    expect(hasSymbol(extraction, "run", { owner: "WorkspaceTransaction", kind: "method" })).toBe(
      true,
    );
    const runId = extraction.symbols.find(
      (s) => s.name === "run" && s.owner === "WorkspaceTransaction",
    )?.id;
    expect(runId).toBeDefined();
    const callees = extraction.edges
      .filter((e) => e.relation === "calls" && e.source === runId)
      .map((e) => e.target);
    expect(callees).toContain("preparePluginCommandApply");
  }),
);

it.live("pluginBehaviourFromPublication exposes object-literal service methods", () =>
  Effect.gen(function* () {
    const extraction = yield* extractRel("packages/amux/src/plugin-behaviour.ts");
    expect(hasSymbol(extraction, "pluginBehaviourFromPublication", { kind: "const" })).toBe(true);
    expect(
      hasSymbol(extraction, "reduce", {
        owner: "pluginBehaviourFromPublication",
        kind: "method",
      }),
    ).toBe(true);
    expect(
      hasSymbol(extraction, "runSession", {
        owner: "pluginBehaviourFromPublication",
        kind: "method",
      }),
    ).toBe(true);
    const bindCallees = callsFrom(extraction, "bindPluginBehaviour").map((e) => e.target);
    expect(bindCallees).toContain("pluginBehaviourFromPublication");
  }),
);

it.live("yield* WorkspaceTransaction then .run is a DI call edge", () =>
  Effect.gen(function* () {
    const extraction = yield* extractRel("packages/amux/src/effect/WorkspaceTransaction.test.ts");
    const di = extraction.edges.filter(
      (e) => e.relation === "calls" && e.di === true && e.target === "WorkspaceTransaction.run",
    );
    expect(di.length).toBeGreaterThanOrEqual(1);
  }),
);

it.live("Context.get(_, Service) then .method is a DI call edge", () =>
  Effect.gen(function* () {
    const extraction = yield* extractRel("packages/amux/src/daemon.ts");
    const di = extraction.edges.filter(
      (e) =>
        e.relation === "calls" &&
        e.di === true &&
        (e.target === "WorkspaceTransaction.run" ||
          e.target === "WorkspaceTransaction.onSessionExit"),
    );
    expect(di.length).toBeGreaterThanOrEqual(1);
  }),
);

it.live("imports are recorded for a file", () =>
  Effect.gen(function* () {
    const extraction = yield* extractRel("packages/amux/src/plugin/loader.ts");
    expect(extraction.imports.some((i) => i.source.includes("effect"))).toBe(true);
    expect(extraction.edges.some((e) => e.relation === "imports")).toBe(true);
  }),
);

it.live("unsupported filetype fails typed", () =>
  Effect.gen(function* () {
    const extractor = yield* CodemapExtractor;
    const error = yield* extractor.extractFile("notes.md", "# hi").pipe(Effect.flip);
    expect(error).toBeInstanceOf(ExtractUnsupportedFiletype);
  }),
);

it.live("inline fixture: Option.match callback call is attributed to the caller", () => {
  const content = `
import { Option } from "effect";
export const bindPluginBehaviour = (slot: unknown) =>
  Option.match(slot as never, {
    onNone: () => notReady(),
    onSome: (publication) => pluginBehaviourFromPublication(publication),
  });
const notReady = () => ({});
const pluginBehaviourFromPublication = (p: unknown) => p;
`;
  return Effect.gen(function* () {
    const extractor = yield* CodemapExtractor;
    const extraction = yield* extractor.extractFile("fixture.ts", content);
    const callees = callsFrom(extraction, "bindPluginBehaviour").map((e) => e.target);
    expect(callees).toContain("pluginBehaviourFromPublication");
    expect(callees).toContain("notReady");
  });
});
