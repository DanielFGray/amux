import { Effect } from "effect";
import { make } from "./file-search.ts";

export interface AgentSearch {
  readonly find: (query: string, limit: number) => Effect.Effect<string, string>;
  readonly glob: (pattern: string, limit: number) => Effect.Effect<string, string>;
  readonly grep: (query: string, limit: number) => Effect.Effect<string, string>;
}

export const makeAgentSearch = Effect.fnUntraced(function* ({
  root,
  session,
}: {
  root: string;
  session: string;
}) {
  const search = yield* make({ root, consumer: `agents/${session}` });
  return {
    find: (query, limit) =>
      search.searchFiles(query, { pageSize: limit }).pipe(
        Effect.map(
          (result) => result.items.map((item) => item.relativePath).join("\n") || "No files found",
        ),
        Effect.mapError((error) => error.message),
      ),
    glob: (pattern, limit) =>
      search.glob(pattern, { pageSize: limit }).pipe(
        Effect.map(
          (result) => result.items.map((item) => item.relativePath).join("\n") || "No files found",
        ),
        Effect.mapError((error) => error.message),
      ),
    grep: (query, limit) =>
      search.grep(query, { pageSize: limit }).pipe(
        Effect.map(
          (result) =>
            result.items
              .map((item) => `${item.relativePath}:${item.lineNumber}: ${item.lineContent}`)
              .join("\n") || "No files found",
        ),
        Effect.mapError((error) => error.message),
      ),
  } satisfies AgentSearch;
});
