import { Tool } from "effect/unstable/ai";
import type { JsonValue } from "@danielfgray/amux";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Duration, Effect, Option, Schema as S, Stream } from "effect";
import {
  languageForPath,
  type LanguageCatalog,
  type LspDiagnostic,
  type LspDocumentClient,
  type LspServiceApi,
} from "@danielfgray/amux-plugin-lsp";

export interface AgentLsp {
  readonly service: LspServiceApi;
  readonly catalog: LanguageCatalog;
}

const LspHover = Tool.make("lsp_hover", {
  description: "Hover information from the language server at a file position (0-based).",
  parameters: S.Struct({
    path: S.String,
    line: S.Finite,
    character: S.Finite,
  }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const LspReferences = Tool.make("lsp_references", {
  description: "Find references to the symbol at a file position (0-based).",
  parameters: S.Struct({
    path: S.String,
    line: S.Finite,
    character: S.Finite,
  }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const LspSymbols = Tool.make("lsp_symbols", {
  description: "List document symbols for a file.",
  parameters: S.Struct({ path: S.String }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const LspCompletion = Tool.make("lsp_completion", {
  description: "Completion candidates at a file position (0-based).",
  parameters: S.Struct({
    path: S.String,
    line: S.Finite,
    character: S.Finite,
  }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

export const lspTools = [LspHover, LspReferences, LspSymbols, LspCompletion] as const;

const fileUri = (absolutePath: string): string => {
  const path = absolutePath.startsWith("/") ? absolutePath : `/${absolutePath}`;
  return `file://${encodeURI(path)}`;
};

const formatDiagnostics = (diagnostics: readonly LspDiagnostic[]): string => {
  if (diagnostics.length === 0) return "";
  return (
    "\n\nDiagnostics:\n" +
    diagnostics
      .map((d) => `L${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`)
      .join("\n")
  );
};

/** Acquire a per-document client for `path` under `workspace`, then run `body`. */
export const withLspClient = <A, E>(
  lsp: AgentLsp,
  workspace: string,
  path: string,
  body: (client: LspDocumentClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E | string> =>
  Effect.scoped(
    Effect.gen(function* () {
      const absolute = path.startsWith("/") ? path : `${workspace}/${path}`;
      const language = Option.getOrUndefined(languageForPath(lsp.catalog, absolute));
      if (!language) return yield* Effect.fail(`no LSP language for ${path}`);
      const client = yield* lsp.service
        .acquire({
          uri: fileUri(absolute),
          language,
          workspace,
        })
        .pipe(
          Effect.mapError((error) => error.message),
          Effect.provide(BunServices.layer),
        );
      return yield* body(client);
    }),
  );

/** Wait briefly for the first diagnostics batch after an edit. */
export const drainDiagnostics = (
  lsp: AgentLsp,
  workspace: string,
  path: string,
): Effect.Effect<string, never> =>
  withLspClient(lsp, workspace, path, (client) =>
    client.diagnostics.pipe(
      Stream.take(1),
      Stream.runHead,
      Effect.map((batch) =>
        Option.match(batch, {
          onNone: () => "",
          onSome: formatDiagnostics,
        }),
      ),
      Effect.timeoutOption(Duration.seconds(2)),
      Effect.map((result) => Option.getOrElse(result, () => "")),
      Effect.orElseSucceed(() => ""),
    ),
  ).pipe(Effect.orElseSucceed(() => ""));

export const lspToolkitHandlers = (
  workspace: string,
  lsp: AgentLsp,
  gated: <E>(
    tool: string,
    action: string,
    resources: readonly string[],
    input: JsonValue,
    body: Effect.Effect<string, E>,
    call?: string,
  ) => Effect.Effect<string, string>,
  paths: (...values: string[]) => Effect.Effect<readonly string[], string>,
) => ({
  lsp_hover: (
    input: { path: string; line: number; character: number },
    context: { toolCallId?: string } = {},
  ) =>
    Effect.gen(function* () {
      const resources = yield* paths(input.path);
      return yield* gated(
        "lsp_hover",
        "read",
        resources,
        input,
        withLspClient(lsp, workspace, input.path, (client) =>
          client.hover({ line: input.line, character: input.character }).pipe(
            Effect.map((hover) =>
              Option.match(hover, {
                onNone: () => "(no hover)",
                onSome: (value) =>
                  typeof value.contents === "string"
                    ? value.contents
                    : JSON.stringify(value.contents),
              }),
            ),
            Effect.mapError((error) => error.message),
          ),
        ),
        context.toolCallId,
      );
    }),
  lsp_references: (
    input: { path: string; line: number; character: number },
    context: { toolCallId?: string } = {},
  ) =>
    Effect.gen(function* () {
      const resources = yield* paths(input.path);
      return yield* gated(
        "lsp_references",
        "read",
        resources,
        input,
        withLspClient(lsp, workspace, input.path, (client) =>
          client.references({ line: input.line, character: input.character }).pipe(
            Effect.map((refs) =>
              refs.length === 0
                ? "(no references)"
                : refs.map((ref) => `${ref.uri}:${ref.range.start.line + 1}`).join("\n"),
            ),
            Effect.mapError((error) => error.message),
          ),
        ),
        context.toolCallId,
      );
    }),
  lsp_symbols: (input: { path: string }, context: { toolCallId?: string } = {}) =>
    Effect.gen(function* () {
      const resources = yield* paths(input.path);
      return yield* gated(
        "lsp_symbols",
        "read",
        resources,
        input,
        withLspClient(lsp, workspace, input.path, (client) =>
          client.symbols.pipe(
            Effect.map((symbols) =>
              symbols.length === 0
                ? "(no symbols)"
                : symbols.map((symbol) => `${symbol.kind} ${symbol.name}`).join("\n"),
            ),
            Effect.mapError((error) => error.message),
          ),
        ),
        context.toolCallId,
      );
    }),
  lsp_completion: (
    input: { path: string; line: number; character: number },
    context: { toolCallId?: string } = {},
  ) =>
    Effect.gen(function* () {
      const resources = yield* paths(input.path);
      return yield* gated(
        "lsp_completion",
        "read",
        resources,
        input,
        withLspClient(lsp, workspace, input.path, (client) =>
          client.completion({ line: input.line, character: input.character }).pipe(
            Effect.map((completion) =>
              Option.match(completion, {
                onNone: () => "(no completions)",
                onSome: (value) => {
                  const items = Array.isArray(value) ? value : "items" in value ? value.items : [];
                  return items.length === 0
                    ? "(no completions)"
                    : items.map((item) => item.label).join("\n");
                },
              }),
            ),
            Effect.mapError((error) => error.message),
          ),
        ),
        context.toolCallId,
      );
    }),
});
