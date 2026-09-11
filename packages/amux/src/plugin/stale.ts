import * as Graph from "effect/Graph";

/**
 * The active plugin entries whose import trees contain `changed`.
 *
 * Import edges run importer -> imported module. Walking their incoming side
 * from a changed module therefore reaches its consumers. A cycle containing
 * the changed module is declined: there is no safe one-directional cache
 * invalidation boundary inside it.
 */
export const staleEntries = (
  graph: Graph.DirectedGraph<string, void>,
  changed: string,
  activeEntries: readonly string[],
): readonly string[] => {
  const nodes = new Map<string, Graph.NodeIndex>();
  for (const [index, url] of graph) nodes.set(url, index);
  const changedNode = nodes.get(changed);
  if (changedNode === undefined) return [];

  const cyclic = new Set(
    Graph.stronglyConnectedComponents(graph)
      .filter((component) => component.length > 1)
      .flat(),
  );
  if (cyclic.has(changedNode)) return [];

  const reachable = new Set(
    Graph.values(Graph.dfs(graph, { start: [changedNode], direction: "incoming" })),
  );
  return activeEntries.filter((entry) => reachable.has(entry));
};
