/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- this benchmark measures the Promise-based OpenTUI render boundary itself. */
import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { BoxRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { RendererContext, _render } from "@opentui/solid";
import type { PaneViewProps } from "@danielfgray/amux";
import { createPluginContributions } from "@danielfgray/amux/plugin/contributions.ts";
import { testPluginEnvironment } from "@danielfgray/amux/testing";
import { optionalEnvVar } from "@danielfgray/amux/session.ts";
import { TreeSitter, treeSitterLayer } from "@danielfgray/amux-highlight";
import { EditorPane, type EditorController } from "../src/EditorPane.tsx";
import { EditorIo, listEntriesWith, runShellCommand, type EditorIoService } from "../src/io.ts";

/** Build the same `EditorIo` shape the plugin installs in production, against
 *  the platform filesystem. The bench's perf measurement must not exclude
 *  the cost of resolving and decoding a file at mount. */
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

const LINE_COUNTS = [100, 1_000, 10_000] as const;
const WARMUP_KEYSTROKES = 40;
const MEASURED_KEYSTROKES = 250;
const WIDTH = 100;
const HEIGHT = 40;

interface Measurement {
  readonly lines: number;
  readonly median: number;
  readonly p95: number;
  readonly mean: number;
}

const key = (name: string): KeyEvent =>
  ({ raw: name, sequence: name, name, eventType: "press" }) as KeyEvent;

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.ceil(sorted.length * fraction) - 1]!;

async function measure(file: string, lines: number, io: EditorIoService): Promise<Measurement> {
  // ManagedRuntime keeps the Parser alive for the whole measure; a short
  // Effect.scoped(Layer.build) would finalize before keystrokes run.
  const treeSitterRuntime = ManagedRuntime.make(
    treeSitterLayer.pipe(
      Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer)),
    ),
  );
  try {
    const treeSitter = await treeSitterRuntime.runPromise(TreeSitter);
    const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
    const content = new BoxRenderable(t.renderer, {
      id: "benchmark-content",
      width: WIDTH,
      height: HEIGHT,
    });
    t.renderer.root.add(content);
    let controller: EditorController | null = null;
    const press = (event: KeyEvent) => {
      if (controller === null) {
        throw new Error("EditorPane did not register its key handler");
      }
      controller.dispatch(event);
    };
    const renderer = t.renderer as CliRenderer;
    const props: PaneViewProps = {
      sessionId: "",
      paneId: "benchmark-pane",
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
    const owner = { id: "benchmark", generation: 1 };
    views.register(owner, "amux.editor", (viewProps) => (
      <EditorPane
        {...viewProps}
        run={() => {}}
        spaceDir="/"
        lineNumbers={() => true}
        keyProfile={() => "vim"}
        io={io}
        treeSitter={treeSitter}
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
      await t.renderOnce();
      await waitUntil(() => t.captureCharFrame().includes("line 000000"));

      press(key("i"));
      await t.renderOnce();
      await Bun.sleep(20);
      press(key("x"));
      await t.renderOnce();
      await Bun.sleep(20);
      expect(t.captureCharFrame()).toContain("xexport const line000000");
      press(key("backspace"));
      await t.renderOnce();
      await Bun.sleep(20);
      expect(t.captureCharFrame()).toContain("export const line000000");
      expect(t.captureCharFrame()).not.toContain("xexport const line000000");
      for (let index = 0; index < WARMUP_KEYSTROKES; index++) {
        press(key(index % 2 === 0 ? "x" : "backspace"));
        await t.renderOnce();
      }

      const samples: number[] = [];
      for (let index = 0; index < MEASURED_KEYSTROKES; index++) {
        const start = performance.now();
        press(key(index % 2 === 0 ? "x" : "backspace"));
        await t.renderOnce();
        samples.push(performance.now() - start);
      }
      samples.sort((left, right) => left - right);

      return {
        lines,
        median: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        mean: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
      };
    } finally {
      dispose();
      t.renderer.destroy();
    }
  } finally {
    await treeSitterRuntime.dispose();
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for editor file load");
    await Bun.sleep(5);
  }
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amux-editor-bench-" });
    const io: EditorIoService = yield* buildBenchIo;
    const results: Measurement[] = [];

    for (const lines of LINE_COUNTS) {
      const file = `${directory}/${lines}.ts`;
      const source = Array.from(
        { length: lines },
        (_, index) =>
          `export const line${String(index).padStart(6, "0")} = "line ${String(index).padStart(6, "0")} representative editor content";`,
      ).join("\n");
      yield* fs.writeFileString(file, `${source}\n`);
      results.push(yield* Effect.promise(() => measure(file, lines, io)));
    }

    console.log("| Lines | Median ms/key | p95 ms/key | Mean ms/key |");
    console.log("| ---: | ---: | ---: | ---: |");
    for (const result of results) {
      console.log(
        `| ${result.lines.toLocaleString("en-US")} | ${result.median.toFixed(3)} | ${result.p95.toFixed(3)} | ${result.mean.toFixed(3)} |`,
      );
    }
  }),
).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer)));

test("editor key-to-render cost", () => Effect.runPromise(program));
