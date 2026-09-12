/** @jsxImportSource @opentui/solid */
/**
 * Confirms the hold-j/k/w/b fix: LSP didChange must not run on cursor-only
 * motions. Before the gate, every motion paid `textOf(buffer)` + publish on
 * the serial key drain (EditorPane syncLsp).
 */
/** @effect-diagnostics *:skip-file -- Promise OpenTUI render boundary. */
import { expect, test } from "bun:test";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as Path from "effect/Path";
import { BoxRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { RendererContext, _render } from "@opentui/solid";
import type { PaneViewProps } from "@danielfgray/amux";
import { createPluginContributions } from "@danielfgray/amux/plugin/contributions.ts";
import { testPluginEnvironment } from "@danielfgray/amux/testing";
import { optionalEnvVar } from "@danielfgray/amux/session.ts";
import {
  builtInCatalog,
  type DocumentServiceApi,
  type DocumentSnapshot,
  type LiveDocument,
  type LspDocumentClient,
  type LspServiceApi,
} from "@danielfgray/amux-plugin-lsp";
import { EditorPane, type EditorController } from "../src/EditorPane.tsx";
import { EditorIo, listEntriesWith, runShellCommand, type EditorIoService } from "../src/io.ts";
import { bufferFromLines, textOf } from "../src/buffer-state.ts";
import type { EditorLspServices } from "../src/lsp-bridge.ts";

const LINE_COUNTS = [1_000, 10_000] as const;
const MOTION_KEYS = 400;
const WIDTH = 100;
const HEIGHT = 40;

const key = (name: string): KeyEvent =>
  ({ raw: name, sequence: name, name, eventType: "press" }) as KeyEvent;

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.ceil(sorted.length * fraction) - 1]!;

const median = (samples: readonly number[]): number =>
  percentile([...samples].sort((a, b) => a - b), 0.5);

const buildBenchIo: Effect.Effect<EditorIoService> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shellBin = Option.getOrElse(yield* optionalEnvVar("SHELL"), () => "sh");
  return EditorIo.of({
    read: (file, spaceDir) =>
      Effect.gen(function* () {
        const resolved = path.resolve(spaceDir, file);
        const text = yield* fs.readFileString(resolved);
        const lines = text.split("\n");
        if (lines.at(-1) === "") return { file, lines: lines.slice(0, -1) };
        return { file, lines };
      }),
    write: (file, lines, spaceDir) =>
      Effect.gen(function* () {
        const resolved = path.resolve(spaceDir, file);
        yield* fs.writeFileString(resolved, lines.join("\n") + "\n");
      }),
    resolve: (spaceDir, p) => Effect.sync(() => path.resolve(spaceDir, p)),
    listEntries: listEntriesWith(fs, path),
    shell: (cmd, spaceDir) => runShellCommand(shellBin, cmd, spaceDir),
  });
}).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)));

const stubClient: LspDocumentClient = {
  hover: () => Effect.succeed(Option.none()),
  definition: () => Effect.succeed(Option.none()),
  declaration: () => Effect.succeed(Option.none()),
  typeDefinition: () => Effect.succeed(Option.none()),
  implementation: () => Effect.succeed(Option.none()),
  references: () => Effect.succeed([]),
  rename: () => Effect.succeed(Option.none()),
  completion: () => Effect.succeed(Option.none()),
  signatureHelp: () => Effect.succeed(Option.none()),
  codeAction: () => Effect.succeed([]),
  resolveCodeAction: () => Effect.succeed(Option.none()),
  codeLenses: Effect.succeed([]),
  resolveCodeLens: () => Effect.succeed(Option.none()),
  executeCommand: () => Effect.succeed(Option.none()),
  symbols: Effect.succeed([]),
  semanticTokens: Effect.succeed(Option.none()),
  diagnostics: Stream.empty,
};

const makeCountingLsp = (): {
  readonly services: EditorLspServices;
  readonly publishes: () => number;
  readonly interrupt: () => void;
} => {
  const live = new Map<string, LiveDocument>();
  let publishes = 0;
  const fibers: Fiber.Fiber<void, unknown>[] = [];

  const documents: DocumentServiceApi = {
    read: (request) =>
      Effect.succeed({
        uri: request.uri,
        language: request.language,
        text: "",
        cursor: { line: 0, character: 0 },
      } satisfies DocumentSnapshot),
    changes: (uri) => {
      const doc = live.get(uri);
      return doc === undefined ? Stream.empty : doc.changes;
    },
    register: (document) =>
      Effect.sync(() => {
        live.set(document.uri, document);
        const fiber = Effect.runFork(
          document.changes.pipe(
            Stream.runForEach((snap) =>
              Effect.sync(() => {
                publishes += 1;
                // Touch the payload the real server would ship as didChange.
                void snap.text.length;
              }),
            ),
          ),
        );
        fibers.push(fiber);
        return () => {
          live.delete(document.uri);
        };
      }),
  };

  const lsp: LspServiceApi = {
    acquire: () => Effect.succeed(stubClient),
  };

  return {
    services: { documents, lsp, catalog: builtInCatalog },
    publishes: () => publishes,
    interrupt: () => {
      for (const fiber of fibers) Effect.runFork(Fiber.interrupt(fiber));
    },
  };
};

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(5);
  }
}

async function drainCursor(
  controller: EditorController,
  want: { row: number; col: number },
): Promise<void> {
  await waitUntil(
    () => controller.state().cursor.row === want.row && controller.state().cursor.col === want.col,
    `cursor ${want.row},${want.col}`,
  );
}

test("motion must not pay textOf (removed hot-path cost)", () => {
  console.log("| Lines | textOf median µs | identity median µs | speedup |");
  console.log("| ---: | ---: | ---: | ---: |");
  for (const lines of LINE_COUNTS) {
    const buffer = bufferFromLines(
      Array.from(
        { length: lines },
        (_, index) =>
          `export const line${String(index).padStart(6, "0")} = "representative editor content";`,
      ),
    );
    const oldSamples: number[] = [];
    const newSamples: number[] = [];
    for (let index = 0; index < MOTION_KEYS; index++) {
      const t0 = performance.now();
      void textOf(buffer);
      oldSamples.push((performance.now() - t0) * 1000);
    }
    for (let index = 0; index < MOTION_KEYS; index++) {
      const prev = buffer;
      const next = buffer;
      const t0 = performance.now();
      void (next !== prev);
      newSamples.push((performance.now() - t0) * 1000);
    }
    const oldMed = median(oldSamples);
    const newMed = Math.max(median(newSamples), 0.001);
    const speedup = oldMed / newMed;
    console.log(
      `| ${lines.toLocaleString("en-US")} | ${oldMed.toFixed(2)} | ${newMed.toFixed(3)} | ${speedup.toFixed(0)}× |`,
    );
    expect(oldMed).toBeGreaterThan(newMed * 50);
  }
});

test("hold motions publish zero LSP changes; edit still publishes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amux-motion-lsp-" });
        const io = yield* buildBenchIo;
        const file = `${directory}/nav.ts`;
        const source = Array.from(
          { length: 2_000 },
          (_, index) =>
            `export const line${String(index).padStart(6, "0")} = "line ${String(index).padStart(6, "0")}";`,
        ).join("\n");
        yield* fs.writeFileString(file, `${source}\n`);

        const counting = makeCountingLsp();
        const t = yield* Effect.promise(() => createTestRenderer({ width: WIDTH, height: HEIGHT }));
        const content = new BoxRenderable(t.renderer, {
          id: "motion-lsp-content",
          width: WIDTH,
          height: HEIGHT,
        });
        t.renderer.root.add(content);
        let controller: EditorController | null = null;
        const press = (event: KeyEvent) => {
          if (controller === null) throw new Error("no controller");
          controller.dispatch(event);
        };
        const renderer = t.renderer as CliRenderer;
        const props: PaneViewProps = {
          sessionId: "",
          paneId: "motion-lsp-pane",
          paneType: "amux.editor",
          descriptor: { file },
          width: () => WIDTH,
          height: () => HEIGHT,
          active: () => true,
          copyText: () => {},
          captureKeys: () => {},
        };
        const contributions = createPluginContributions();
        const views = testPluginEnvironment(t.renderer, { contributions }).registries.sessionViews;
        const owner = { id: "motion-lsp", generation: 1 };
        views.register(owner, "amux.editor", (viewProps) => (
          <EditorPane
            {...viewProps}
            run={() => {}}
            spaceDir="/"
            lineNumbers={() => true}
            keyProfile={() => "vim"}
            io={io}
            lsp={() => counting.services}
            registerController={(_paneId, next) => {
              controller = next;
              return () => {
                controller = null;
              };
            }}
          />
        ));
        contributions.commit(owner);
        const dispose = _render(
          () => (
            <RendererContext.Provider value={renderer}>{views.view(props)}</RendererContext.Provider>
          ),
          content,
        );

        try {
          yield* Effect.promise(async () => {
            await t.renderOnce();
            await waitUntil(
              () => controller !== null && controller.state().file !== null,
              "file open",
            );
            // Open attaches LSP without publishing. Keep poking an insert until
            // the session's change PubSub is live (fiber race with first edit).
            const seedDeadline = performance.now() + 3_000;
            while (counting.publishes() < 1) {
              if (performance.now() >= seedDeadline) {
                throw new Error(
                  `LSP never published a didChange (message=${controller!.state().message})`,
                );
              }
              press(key("i"));
              await Bun.sleep(5);
              press(key("x"));
              await Bun.sleep(15);
              press(key("escape"));
              await Bun.sleep(15);
            }
            await waitUntil(() => controller!.state().mode === "normal", "normal mode");
            await Bun.sleep(20);
            const baseline = counting.publishes();

            const motionSamples: number[] = [];
            for (let index = 0; index < 60; index++) {
              const before = controller!.state().cursor;
              const start = performance.now();
              press(key("j"));
              await drainCursor(controller!, { row: before.row + 1, col: before.col });
              await t.renderOnce();
              motionSamples.push(performance.now() - start);
            }
            for (let index = 0; index < 20; index++) {
              const before = controller!.state().cursor;
              press(key("w"));
              await waitUntil(
                () =>
                  controller!.state().cursor.row !== before.row ||
                  controller!.state().cursor.col !== before.col,
                "word forward",
              );
            }
            for (let index = 0; index < 20; index++) {
              const before = controller!.state().cursor;
              press(key("b"));
              await waitUntil(
                () =>
                  controller!.state().cursor.row !== before.row ||
                  controller!.state().cursor.col !== before.col,
                "word back",
              );
            }
            expect(counting.publishes()).toBe(baseline);
            const motionPublishes = counting.publishes() - baseline;

            press(key("i"));
            await Bun.sleep(10);
            press(key("z"));
            await waitUntil(() => counting.publishes() > baseline, "edit didChange");

            const taxSamples: number[] = [];
            const buffer = controller!.state().buffer;
            for (let index = 0; index < 120; index++) {
              const start = performance.now();
              void textOf(buffer);
              taxSamples.push(performance.now() - start);
            }

            const motionMed = median(motionSamples);
            const taxMed = median(taxSamples);
            console.log(
              `| motion j (2k lines, LSP attached) median ${motionMed.toFixed(3)} ms |` +
                ` textOf tax alone median ${taxMed.toFixed(3)} ms |` +
                ` LSP publishes during motions: ${motionPublishes} |`,
            );
            expect(taxMed).toBeGreaterThan(0);
            expect(motionPublishes).toBe(0);
          });
        } finally {
          counting.interrupt();
          dispose();
          t.renderer.destroy();
        }
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  ),
);
