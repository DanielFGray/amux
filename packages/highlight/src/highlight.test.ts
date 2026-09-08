import { expect } from "bun:test";
import { Effect } from "effect";
import { testEffect } from "@danielfgray/amux/testing";
import { theme } from "@danielfgray/amux";
import {
  makeHighlightProvider,
  type HighlightClient,
  type HighlightListener,
  type HighlightProviderService,
  type LineChunks,
} from "./highlight.ts";
import type {
  FiletypeParserOptions,
  HighlightResponse,
  SimpleHighlight,
} from "@opentui/core";

type ResponseListener = (
  bufferId: number,
  version: number,
  highlights: HighlightResponse[],
) => void;

/** In-memory stand-in for the worker client: records buffer calls and lets
 *  the test fire `highlights:response` on demand. */
class FakeHighlightClient implements HighlightClient {
  readonly buffers = new Map<number, { content: string; filetype: string; version: number }>();
  readonly removed: number[] = [];
  readonly listeners = new Set<ResponseListener>();
  failCreate = false;
  failUpdate = false;

  initialize(): Promise<void> {
    return Promise.resolve();
  }
  createBuffer(id: number, content: string, filetype: string): Promise<boolean> {
    if (this.failCreate) return Promise.reject(new Error("create failed"));
    this.buffers.set(id, { content, filetype, version: 1 });
    return Promise.resolve(true);
  }
  resetBuffer(id: number, version: number, newContent: string): Promise<void> {
    if (this.failUpdate) return Promise.reject(new Error("update failed"));
    const state = this.buffers.get(id);
    if (state === undefined) return Promise.reject(new Error("unknown buffer"));
    state.content = newContent;
    state.version = version;
    return Promise.resolve();
  }
  removeBuffer(bufferId: number): Promise<void> {
    this.removed.push(bufferId);
    this.buffers.delete(bufferId);
    return Promise.resolve();
  }
  readonly addedParsers: string[] = [];
  addFiletypeParser(parser: FiletypeParserOptions): void {
    this.addedParsers.push(parser.filetype);
  }
  highlightOnce(
    content: string,
    filetype: string,
  ): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }> {
    return Promise.resolve(this.snapshotResult(content, filetype));
  }
  snapshotResult: (
    content: string,
    filetype: string,
  ) => { highlights?: SimpleHighlight[]; warning?: string; error?: string } = () => ({
    highlights: [],
  });
  on(_event: "highlights:response", listener: ResponseListener): unknown {
    this.listeners.add(listener);
    return undefined;
  }
  off(_event: "highlights:response", listener: ResponseListener): unknown {
    this.listeners.delete(listener);
    return undefined;
  }
  emit(bufferId: number, version: number, highlights: HighlightResponse[]): void {
    for (const listener of this.listeners) listener(bufferId, version, highlights);
  }
}

const response = (
  line: number,
  highlights: { startCol: number; endCol: number; group: string }[],
): HighlightResponse => ({ line, highlights, droppedHighlights: [] });

const listen = (
  seen: { file: string; version: number; chunks: LineChunks }[],
): HighlightListener => {
  return (file, version, chunks) => {
    seen.push({ file, version, chunks });
  };
};

const concatLine = (chunks: LineChunks, row: number): string =>
  (chunks.get(row) ?? []).map((chunk) => chunk.text).join("");

/** Buffer ids come from a process-wide counter, so tests read the id back
 *  instead of assuming it. */
const onlyBuffer = (client: FakeHighlightClient): number => {
  const ids = [...client.buffers.keys()];
  expect(ids).toHaveLength(1);
  return ids[0]!;
};

testEffect(
  "open publishes styled chunks for a known filetype",
  Effect.gen(function* () {
    const client = new FakeHighlightClient();
    const provider = yield* makeHighlightProvider(client);
    const seen: { file: string; version: number; chunks: LineChunks }[] = [];
    provider.subscribe(listen(seen));

    const line = 'import x from "y";';
    yield* provider.open("/w/foo.ts", line);
    expect(client.buffers.size).toBe(1);
    client.emit(onlyBuffer(client), 1, [response(0, [{ startCol: 0, endCol: 6, group: "keyword.import" }])]);

    expect(seen.length).toBe(1);
    expect(seen[0]!.file).toBe("/w/foo.ts");
    // Concatenated chunks always equal the line, styled or not.
    expect(concatLine(seen[0]!.chunks, 0)).toBe(line);
    const first = seen[0]!.chunks.get(0)![0]!;
    expect(first.text).toBe("import");
    // keyword.import falls back to the keyword base color (mauve).
    expect(first.fg?.toString()).toBe(theme.mauve.toString());
  }),
);

testEffect(
  "unknown extensions stay plain and never touch the client",
  Effect.gen(function* () {
    const client = new FakeHighlightClient();
    const provider = yield* makeHighlightProvider(client);
    const seen: { file: string; version: number; chunks: LineChunks }[] = [];
    provider.subscribe(listen(seen));

    yield* provider.open("/w/note.txt", "contents");
    yield* provider.update("/w/note.txt", "contents!");
    expect(client.buffers.size).toBe(0);
    expect(seen.length).toBe(0);
  }),
);

testEffect(
  "stale versions are ignored, current ones publish",
  Effect.gen(function* () {
    const client = new FakeHighlightClient();
    const provider: HighlightProviderService = yield* makeHighlightProvider(client);
    const seen: { file: string; version: number; chunks: LineChunks }[] = [];
    provider.subscribe(listen(seen));

    yield* provider.open("/w/foo.ts", "aaa");
    yield* provider.update("/w/foo.ts", "aab");
    client.emit(onlyBuffer(client), 1, [response(0, [])]);
    expect(seen.length).toBe(0);
    client.emit(onlyBuffer(client), 2, [response(0, [])]);
    expect(seen.length).toBe(1);
    expect(seen[0]!.version).toBe(2);
    expect(concatLine(seen[0]!.chunks, 0)).toBe("aab");
  }),
);

testEffect(
  "close removes the buffer and late responses go nowhere",
  Effect.gen(function* () {
    const client = new FakeHighlightClient();
    const provider = yield* makeHighlightProvider(client);
    const seen: { file: string; version: number; chunks: LineChunks }[] = [];
    provider.subscribe(listen(seen));

    yield* provider.open("/w/foo.ts", "aaa");
    const id = onlyBuffer(client);
    yield* provider.close("/w/foo.ts");
    expect(client.buffers.size).toBe(0);
    expect(client.removed).toEqual([id]);
    client.emit(id, 1, [response(0, [])]);
    expect(seen.length).toBe(0);
  }),
);

testEffect(
  "client failures degrade to plain text without failing",
  Effect.gen(function* () {
    const client = new FakeHighlightClient();
    client.failCreate = true;
    const provider = yield* makeHighlightProvider(client);
    const seen: { file: string; version: number; chunks: LineChunks }[] = [];
    provider.subscribe(listen(seen));

    yield* provider.open("/w/foo.ts", "aaa");
    expect(client.buffers.size).toBe(0);
    expect(seen.length).toBe(0);

    client.failCreate = false;
    client.failUpdate = true;
    yield* provider.open("/w/bar.ts", "bbb");
    expect(client.buffers.size).toBe(1);
    yield* provider.update("/w/bar.ts", "bbc");
    // The failed update drops the buffer; nothing publishes.
    expect(client.buffers.size).toBe(0);
    expect(seen.length).toBe(0);
  }),
);

testEffect(
  "duplicate and overlapping ranges keep the line intact",
  Effect.gen(function* () {
    const client = new FakeHighlightClient();
    const provider = yield* makeHighlightProvider(client);
    const seen: { file: string; version: number; chunks: LineChunks }[] = [];
    provider.subscribe(listen(seen));

    const line = "const x = 1;";
    yield* provider.open("/w/foo.ts", line);
    client.emit(onlyBuffer(client), 1, [
      response(0, [
        { startCol: 6, endCol: 7, group: "variable" },
        { startCol: 6, endCol: 7, group: "type" },
        { startCol: 6, endCol: 7, group: "constant" },
        { startCol: 40, endCol: 60, group: "keyword" },
        { startCol: -5, endCol: 2, group: "keyword" },
      ]),
    ]);
    expect(seen.length).toBe(1);
    expect(concatLine(seen[0]!.chunks, 0)).toBe(line);
  }),
);

testEffect(
  "snapshot highlights static content without a buffer",
  Effect.gen(function* () {
    const client = new FakeHighlightClient();
    client.snapshotResult = () => ({ highlights: [[0, 6, "keyword"]] as SimpleHighlight[] });
    const provider = yield* makeHighlightProvider(client);

    const chunks = yield* provider.snapshot('import x from "y";', "typescript");
    expect(chunks !== null).toBe(true);
    const row = chunks!.get(0) ?? [];
    expect(row.map((chunk) => chunk.text).join("")).toBe('import x from "y";');
    expect(row[0]!.text).toBe("import");
    expect(row[0]!.fg?.toString()).toBe(theme.mauve.toString());
    // No buffer was opened for a snapshot.
    expect(client.buffers.size).toBe(0);
  }),
);

testEffect(
  "snapshot is null when there is nothing to highlight",
  Effect.gen(function* () {
    const client = new FakeHighlightClient();
    const provider = yield* makeHighlightProvider(client);

    expect(yield* provider.snapshot("plain", "typescript")).toBeNull();
    client.snapshotResult = () => ({ error: "no parser" });
    expect(yield* provider.snapshot("plain", "typescript")).toBeNull();
  }),
);

testEffect(
  "two providers sharing a client never collide on buffer ids",
  Effect.gen(function* () {
    const client = new FakeHighlightClient();
    const first = yield* makeHighlightProvider(client);
    const second = yield* makeHighlightProvider(client);

    yield* first.open("/w/a.ts", "aaa");
    yield* second.open("/w/b.ts", "bbb");
    const ids = [...client.buffers.keys()];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  }),
);

testEffect(
  "extra parsers register at first init",
  Effect.gen(function* () {
    const client = new FakeHighlightClient();
    const extra: FiletypeParserOptions[] = [
      { filetype: "json", wasm: "/cache/json.wasm", queries: { highlights: ["/cache/json.scm"] } },
    ];
    const provider = yield* makeHighlightProvider(client, extra);
    expect(client.addedParsers).toEqual([]);
    yield* provider.open("/w/data.json", "{}");
    expect(client.addedParsers).toEqual(["json"]);
  }),
);
