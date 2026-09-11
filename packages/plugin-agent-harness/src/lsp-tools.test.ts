import { expect } from "bun:test";
import { AiError, Tool } from "effect/unstable/ai";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { testEffect } from "@danielfgray/amux/testing";
import { registerCleanup, tempDir } from "@danielfgray/amux/test-tmp.ts";
import { agentToolkit } from "./tools.ts";
import { withLspClient, type AgentLsp } from "./lsp-tools.ts";
import {
  DocumentService,
  LspService,
  builtInCatalog,
  makeDocumentService,
  type LspNotification,
  type LspServiceOptions,
  type LspTransport,
} from "@danielfgray/amux-plugin-lsp";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as FileSystem from "effect/FileSystem";
import { PermissionGateTag, type Assertion, type PermissionGate } from "./permission.ts";
import type { JsonValue } from "@danielfgray/amux";

registerCleanup();

const it = testEffect(BunServices.layer);

const runHandle = <A, E, R>(effect: Effect.Effect<Stream.Stream<A, E, R>, AiError.AiError>) =>
  effect.pipe(Effect.flatMap(Stream.runLast), Effect.map(Option.getOrThrow));

const allowAll = () => {
  const gate: PermissionGate = {
    assert: () => Effect.void,
    resolve: () => Effect.void,
  };
  return gate;
};

const withGate = <A, E, R>(gate: PermissionGate, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(PermissionGateTag, gate));

const noInstructions = () => {
  const attached = new Set<string>();
  return {
    attachedInstructions: () => Effect.succeed(attached),
    attachInstructions: (_session: string, paths: readonly string[]) =>
      Effect.sync(() => {
        for (const path of paths) attached.add(path);
      }),
  };
};

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 4 },
};

const makeFakeLsp = (
  notifications: Stream.Stream<LspNotification> = Stream.empty,
): NonNullable<LspServiceOptions["spawn"]> => {
  return () =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const transport: LspTransport = {
          pid: 1,
          notifications,
          request: (method) =>
            Effect.sync((): JsonValue => {
              if (method === "initialize") return { capabilities: {} };
              if (method === "textDocument/hover") return { contents: "hover-text" };
              if (method === "textDocument/references")
                return [{ uri: "file:///workspace/a.ts", range }];
              if (method === "textDocument/documentSymbol")
                return [{ name: "x", kind: 13, range, selectionRange: range }];
              if (method === "textDocument/completion") return [{ label: "completeMe" }];
              return [];
            }),
          notify: () => Effect.void,
        };
        return transport;
      }),
      () => Effect.void,
    );
};

const makeAgentLsp = Effect.fnUntraced(function* (
  notifications: Stream.Stream<LspNotification> = Stream.empty,
) {
  const documents = yield* makeDocumentService();
  const service = yield* LspService.make({
    catalog: builtInCatalog,
    spawn: makeFakeLsp(notifications),
  }).pipe(Effect.provideService(DocumentService, documents));
  return { service, catalog: builtInCatalog } satisfies AgentLsp;
});

const withDocs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(BunServices.layer, Layer.effect(DocumentService, makeDocumentService())),
    ),
  );

const workspaceWithTs = Effect.fnUntraced(function* () {
  const root = yield* Effect.sync(() => tempDir("lsp-tools-"));
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${root}/main.ts`, "const x = 1;\n");
  return root;
});

it.live("lsp tools appear when AgentLsp is provided", () =>
  withDocs(
    Effect.gen(function* () {
      const lsp = yield* makeAgentLsp();
      const toolkit = yield* withGate(allowAll(), agentToolkit(
        process.cwd(),
        { session: "agent-1", store: noInstructions() },
        { lsp },
      ));
      expect(Object.keys(toolkit.tools).sort()).toEqual(
        [
          "apply_patch",
          "bash",
          "edit",
          "find",
          "glob",
          "grep",
          "lsp_completion",
          "lsp_hover",
          "lsp_references",
          "lsp_symbols",
          "read",
          "write",
        ].sort(),
      );
      for (const tool of Object.values(toolkit.tools)) {
        expect(Tool.getJsonSchema(tool as never)).toMatchObject({ type: "object" });
      }
    }),
  ),
);

it.live("lsp_hover is permission-gated and returns hover text", () =>
  withDocs(
    Effect.gen(function* () {
      const workspace = yield* workspaceWithTs();
      const seen: Assertion[] = [];
      const gate: PermissionGate = {
        assert: (assertion) =>
          Effect.sync(() => {
            seen.push(assertion);
          }),
        resolve: () => Effect.void,
      };
      const lsp = yield* makeAgentLsp();
      const toolkit = yield* withGate(gate, agentToolkit(
        workspace,
        { session: "agent-1", store: noInstructions() },
        { lsp },
      ));
      const output = yield* runHandle(
        toolkit.handle("lsp_hover", {
          path: "main.ts",
          line: 0,
          character: 0,
        }),
      );
      expect((output as { result: unknown }).result).toBe("hover-text");
      expect(seen[0]?.tool).toBe("lsp_hover");
      expect(seen[0]?.action).toBe("read");
    }),
  ),
);

it.live("withLspClient fails cleanly for unknown languages", () =>
  withDocs(
    Effect.gen(function* () {
      const lsp = yield* makeAgentLsp();
      const result = yield* Effect.result(
        withLspClient(lsp, "/workspace", "main.go", () => Effect.succeed("ok")),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  ),
);
