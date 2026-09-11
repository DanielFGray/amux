import { expect, test } from "bun:test";
import * as Graph from "effect/Graph";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path computation, not I/O.
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { staleEntries } from "./stale.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));

const importGraph = (edges: readonly (readonly [string, string])[]) => {
  const nodes = new Map<string, Graph.NodeIndex>();
  return Graph.directed<string, void>((graph) => {
    const node = (url: string) => {
      const existing = nodes.get(url);
      if (existing !== undefined) return existing;
      const added = Graph.addNode(graph, url);
      nodes.set(url, added);
      return added;
    };
    for (const [importer, imported] of edges)
      Graph.addEdge(graph, node(importer), node(imported), undefined);
  });
};

test("a changed shared module makes each active consumer stale", () => {
  const sidebar = pathToFileURL(join(testDir, "../../../plugin-sidebar/src/index.tsx")).href;
  const harness = pathToFileURL(join(testDir, "../../../plugin-agent-harness/src/index.tsx")).href;
  const changed = pathToFileURL(join(testDir, "../../../agent-awareness/src/presence.ts")).href;
  const graph = importGraph([
    [sidebar, changed],
    [harness, changed],
  ]);

  expect(staleEntries(graph, changed, [sidebar, harness])).toEqual([sidebar, harness]);
});

test("declines a changed module within an import cycle", () => {
  const entry = "file:///plugins/sidebar.tsx";
  const first = "file:///packages/agent-awareness/first.ts";
  const second = "file:///packages/agent-awareness/second.ts";
  const graph = importGraph([
    [entry, first],
    [first, second],
    [second, first],
  ]);

  expect(staleEntries(graph, first, [entry])).toEqual([]);
});
