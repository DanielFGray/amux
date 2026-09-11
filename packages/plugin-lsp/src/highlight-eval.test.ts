/**
 * Head-to-head evidence for ts-6b2753: tree-sitter HighlightProvider vs LSP
 * semanticTokens/full on the same TypeScript sample.
 *
 * Not a CI gate — skips when typescript-language-server is missing. Numbers
 * feed the provider decision recorded on the prog task.
 */
import { expect } from "bun:test";
import { Clock, Effect, Layer, Option, Schema as S } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as FileSystem from "effect/FileSystem";
import { testEffect } from "../../amux/src/test-effect.ts";
import { registerCleanup, tempDir } from "../../amux/src/test-tmp.ts";
import { makeHighlightProvider } from "@danielfgray/amux-highlight";
import { DocumentService, makeDocumentService } from "./document.ts";
import { LspService } from "./service.ts";
import { builtInCatalog } from "./catalog.ts";
import { decodeSemanticTokens, tokenCoverage } from "./semantic-tokens.ts";

registerCleanup();

const it = testEffect(BunServices.layer);

const SAMPLE = `import { Effect, Option } from "effect";

/** A tiny sample the spike times against both providers. */
export const greet = (name: string): string => {
  const message = Option.getOrElse(Option.some(name), () => "world");
  return Effect.runSync(Effect.succeed(\`hello \${message}\`));
};

export type Greeter = typeof greet;
`;

const which = (command: string): boolean => {
  try {
    const result = Bun.spawnSync(["which", command], { stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
};

const timed = <A, E, R>(
  body: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly ms: number; readonly value: A }, E, R> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const value = yield* body;
    const end = yield* Clock.currentTimeMillis;
    return { ms: end - start, value };
  });

it.live("eval: tree-sitter snapshot vs LSP semanticTokens on one TS file", () =>
  Effect.gen(function* () {
    if (!which("typescript-language-server")) {
      yield* Effect.log("skip: typescript-language-server not on PATH");
      return;
    }

    const root = yield* Effect.sync(() => tempDir("highlight-eval-"));
    const fs = yield* FileSystem.FileSystem;
    const file = `${root}/sample.ts`;
    yield* fs.writeFileString(file, SAMPLE);

    // --- tree-sitter path (already the editor's live provider) ---
    const highlight = yield* makeHighlightProvider();
    const treeOnce = yield* timed(highlight.snapshot(SAMPLE, "typescript"));
    // Warm: second call should hit an initialized worker.
    const treeWarm = yield* timed(highlight.snapshot(SAMPLE, "typescript"));
    yield* highlight.shutdown;

    // --- LSP semanticTokens path ---
    const documents = yield* makeDocumentService();
    const lsp = yield* LspService.make({ catalog: builtInCatalog }).pipe(
      Effect.provideService(DocumentService, documents),
    );
    const uri = `file://${file}`;
    const client = yield* lsp.acquire({
      uri,
      language: "typescript",
      workspace: root,
    });

    const decodeTokens = client.semanticTokens.pipe(
      Effect.map((tokens) =>
        Option.match(tokens, {
          onNone: () => null,
          onSome: (value) => decodeSemanticTokens(value),
        }),
      ),
    );
    const lspCold = yield* timed(decodeTokens);
    const lspWarm = yield* timed(decodeTokens);

    const treeChunks = treeWarm.value;
    const treeLines = treeChunks?.size ?? 0;
    const lspRanges = lspWarm.value;
    const lspCoverage = lspRanges ? tokenCoverage(lspRanges) : 0;

    const report = {
      sampleBytes: SAMPLE.length,
      treeSitter: {
        coldMs: Math.round(treeOnce.ms),
        warmMs: Math.round(treeWarm.ms),
        highlightedLines: treeLines,
      },
      semanticTokens: {
        coldMs: Math.round(lspCold.ms),
        warmMs: Math.round(lspWarm.ms),
        tokens: lspRanges?.length ?? 0,
        coverageChars: lspCoverage,
      },
    };
    yield* Effect.log(yield* S.encodeEffect(S.fromJsonString(S.Unknown, { space: 2 }))(report));

    // Both sources must produce some coloring on this sample — otherwise the
    // eval has nothing to compare.
    expect(treeLines).toBeGreaterThan(0);
    expect(lspRanges?.length ?? 0).toBeGreaterThan(0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(BunServices.layer, Layer.effect(DocumentService, makeDocumentService())),
    ),
  ),
);
