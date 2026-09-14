import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Fiber, Layer, Option, PubSub, Stream } from "effect";
import { expect } from "bun:test";
import { testEffect } from "../../amux/src/test-effect.ts";
import { DocumentService, makeDocumentService, type DocumentSnapshot } from "./document.ts";
import { builtInCatalog } from "./catalog.ts";
import { LspService, decodeShowReferencesArgs, type LspServiceOptions } from "./service.ts";
import type { LspNotification, LspTransport } from "./transport.ts";
import type { Schema as S } from "effect";

type Json = S.Json;

const tests = testEffect(BunServices.layer);

const snapshot = (uri: string, text: string): DocumentSnapshot => ({
  uri,
  language: "typescript",
  text,
  cursor: { line: 0, character: 0 },
});

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 4 },
};

const makeFake = (notifications: Stream.Stream<LspNotification> = Stream.empty) => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const pids: number[] = [];
  const closed: number[] = [];
  const spawn: NonNullable<LspServiceOptions["spawn"]> = (options) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const pid = pids.length + 1;
        pids.push(pid);
        const transport: LspTransport = {
          pid,
          notifications,
          request: (method, params) =>
            Effect.sync((): Json => {
              calls.push({ method, params });
              if (method === "initialize") return { capabilities: {} };
              if (method === "textDocument/hover")
                return { contents: { kind: "markdown", value: "**hover**" } };
              if (method === "textDocument/definition")
                return { uri: "file:///workspace/def.ts", range };
              if (method === "textDocument/declaration")
                return { uri: "file:///workspace/decl.ts", range };
              if (method === "textDocument/typeDefinition")
                return { uri: "file:///workspace/type.ts", range };
              if (method === "textDocument/implementation")
                return { uri: "file:///workspace/impl.ts", range };
              if (method === "textDocument/signatureHelp")
                return { signatures: [{ label: "fn(x: number)" }], activeSignature: 0 };
              if (method === "textDocument/codeAction")
                return [
                  {
                    title: "fix it",
                    edit: {
                      changes: {
                        "file:///workspace/typed.ts": [{ range, newText: "fixed" }],
                      },
                    },
                  },
                  {
                    title: "organize imports",
                    command: "source.organizeImports",
                    arguments: [],
                  },
                ];
              if (method === "codeAction/resolve")
                return {
                  title: "fix it",
                  edit: {
                    changes: {
                      "file:///workspace/typed.ts": [{ range, newText: "fixed" }],
                    },
                  },
                  command: { title: "fix it", command: "editor.action.fix", arguments: [] },
                };
              if (method === "textDocument/codeLens")
                return [
                  {
                    range,
                    data: { id: 1 },
                  },
                  {
                    range,
                    command: {
                      title: "2 references",
                      command: "editor.action.showReferences",
                      arguments: [],
                    },
                  },
                ];
              if (method === "codeLens/resolve")
                return {
                  range,
                  command: {
                    title: "1 reference",
                    command: "editor.action.showReferences",
                    arguments: ["file:///workspace/typed.ts"],
                  },
                  data: { id: 1 },
                };
              if (method === "workspace/executeCommand") return { ok: true };
              if (method === "textDocument/references")
                return [{ uri: "file:///workspace/ref.ts", range }];
              if (method === "textDocument/rename")
                return {
                  changes: {
                    "file:///workspace/typed.ts": [{ range, newText: "renamed" }],
                  },
                };
              if (method === "textDocument/completion") return [{ label: "typed", kind: 6 }];
              if (method === "textDocument/documentSymbol")
                return [
                  {
                    name: "typed",
                    kind: 13,
                    range,
                    selectionRange: range,
                  },
                ];
              if (method === "textDocument/semanticTokens/full") return { data: [0, 0, 5, 1, 0] };
              return [];
            }),
          notify: (method, params) =>
            Effect.sync(() => {
              calls.push({ method, params });
            }),
        };
        calls.push({ method: "spawn", params: options });
        return transport;
      }),
      (transport) => Effect.sync(() => closed.push(transport.pid)),
    );
  return { calls, pids, closed, spawn };
};

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.merge(BunServices.layer, Layer.effect(DocumentService, makeDocumentService())),
    ),
  );

tests.live(
  "shares a server per language and root and closes the document on the last scope",
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const changes = yield* PubSub.sliding<DocumentSnapshot>({ capacity: 4, replay: 1 });
      const document = yield* DocumentService;
      const uri = "file:///workspace/main.ts";
      const release = yield* document.register({
        uri,
        snapshot: Effect.succeed(snapshot(uri, "export const value = 1;\n")),
        changes: Stream.fromPubSub(changes),
      });
      yield* Effect.addFinalizer(() => Effect.sync(release));
      const service = yield* LspService;

      yield* Effect.gen(function* () {
        yield* service.acquire({ uri, language: "typescript", workspace: "/workspace" });
        yield* service.acquire({ uri, language: "typescript", workspace: "/workspace" });
        yield* Effect.yieldNow;
        yield* PubSub.publish(changes, snapshot(uri, "export const value = 2;\n"));
        yield* Effect.yieldNow;
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(LspService.layer({ catalog: builtInCatalog, spawn: fake.spawn })));

    expect(fake.pids).toEqual([1]);
    expect(fake.calls.filter((call) => call.method === "spawn")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "textDocument/didOpen")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "textDocument/didChange")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "textDocument/didClose")).toHaveLength(1);
    expect(fake.closed).toEqual([1]);
  }).pipe(Effect.scoped, provide),
);

tests.live(
  "exposes every typed capability and filters diagnostics to the acquired URI",
  Effect.gen(function* () {
    const notifications = yield* PubSub.sliding<LspNotification>({ capacity: 4 });
    const fake = makeFake(Stream.fromPubSub(notifications));
    yield* Effect.gen(function* () {
      const document = yield* DocumentService;
      const uri = "file:///workspace/typed.ts";
      yield* document.register({
        uri,
        snapshot: Effect.succeed(snapshot(uri, "const typed = true;\n")),
        changes: Stream.empty,
      });
      const service = yield* LspService;
      yield* Effect.gen(function* () {
        const client = yield* service.acquire({
          uri,
          language: "typescript",
          workspace: "/workspace",
        });
        const position = { line: 0, character: 0 };
        const hover = yield* client.hover(position);
        expect(Option.getOrUndefined(hover)).toMatchObject({
          contents: { kind: "markdown", value: "**hover**" },
        });
        const definition = yield* client.definition(position);
        expect(Option.getOrUndefined(definition)).toMatchObject({
          uri: "file:///workspace/def.ts",
          range,
        });
        const declaration = yield* client.declaration(position);
        expect(Option.getOrUndefined(declaration)).toMatchObject({
          uri: "file:///workspace/decl.ts",
          range,
        });
        const typeDefinition = yield* client.typeDefinition(position);
        expect(Option.getOrUndefined(typeDefinition)).toMatchObject({
          uri: "file:///workspace/type.ts",
          range,
        });
        const implementation = yield* client.implementation(position);
        expect(Option.getOrUndefined(implementation)).toMatchObject({
          uri: "file:///workspace/impl.ts",
          range,
        });
        const signature = yield* client.signatureHelp(position);
        expect(Option.getOrUndefined(signature)).toMatchObject({
          signatures: [{ label: "fn(x: number)" }],
        });
        const actions = yield* client.codeAction(range);
        expect(actions).toHaveLength(2);
        expect(actions[0]?.title).toBe("fix it");
        expect(actions[1]?.title).toBe("organize imports");
        const resolvedAction = yield* client.resolveCodeAction({
          title: "fix it",
          data: { id: 1 },
        });
        expect(Option.getOrUndefined(resolvedAction)?.command?.command).toBe("editor.action.fix");
        const lenses = yield* client.codeLenses;
        expect(lenses).toHaveLength(2);
        expect(lenses[1]?.command?.title).toBe("2 references");
        const resolved = yield* client.resolveCodeLens(lenses[0]!);
        expect(Option.getOrUndefined(resolved)?.command?.title).toBe("1 reference");
        const executed = yield* client.executeCommand({
          title: "run",
          command: "test.cmd",
          arguments: [1],
        });
        expect(Option.getOrUndefined(executed)).toEqual({ ok: true });
        const references = yield* client.references(position);
        expect(references).toEqual([{ uri: "file:///workspace/ref.ts", range }]);
        const rename = yield* client.rename(position, "renamed");
        expect(Option.getOrUndefined(rename)).toEqual({
          changes: {
            "file:///workspace/typed.ts": [{ range, newText: "renamed" }],
          },
        });
        const completion = yield* client.completion(position);
        expect(Option.getOrUndefined(completion)).toEqual([{ label: "typed", kind: 6 }]);
        const symbols = yield* client.symbols;
        expect(symbols).toEqual([{ name: "typed", kind: 13, range, selectionRange: range }]);
        const tokens = yield* client.semanticTokens;
        expect(Option.getOrUndefined(tokens)).toEqual({ data: [0, 0, 5, 1, 0] });
        const diagnostics = yield* Effect.forkScoped(client.diagnostics.pipe(Stream.runHead));
        yield* Effect.yieldNow;
        yield* PubSub.publish(notifications, {
          method: "textDocument/publishDiagnostics",
          params: {
            uri,
            diagnostics: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                message: "typed error",
              },
            ],
          },
        });
        yield* PubSub.publish(notifications, {
          method: "textDocument/publishDiagnostics",
          params: {
            uri: "file:///workspace/other.ts",
            diagnostics: [{ range, message: "other file" }],
          },
        });
        const batch = yield* Fiber.join(diagnostics);
        expect(Option.getOrUndefined(batch)?.[0]).toMatchObject({ message: "typed error" });
        expect(
          fake.calls
            .map((call) => call.method)
            .filter((method) => method.startsWith("textDocument/")),
        ).toEqual([
          "textDocument/didOpen",
          "textDocument/hover",
          "textDocument/definition",
          "textDocument/declaration",
          "textDocument/typeDefinition",
          "textDocument/implementation",
          "textDocument/signatureHelp",
          "textDocument/codeAction",
          "textDocument/codeLens",
          "textDocument/references",
          "textDocument/rename",
          "textDocument/completion",
          "textDocument/documentSymbol",
          "textDocument/semanticTokens/full",
        ]);
        expect(fake.calls.map((call) => call.method)).toContain("codeAction/resolve");
        expect(fake.calls.map((call) => call.method)).toContain("codeLens/resolve");
        expect(fake.calls.map((call) => call.method)).toContain("workspace/executeCommand");
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(LspService.layer({ catalog: builtInCatalog, spawn: fake.spawn })));
  }).pipe(Effect.scoped, provide),
);

tests.live(
  "starts separate servers for separate workspace roots",
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const document = yield* DocumentService;
      const service = yield* LspService;
      const first = "file:///workspace-one/main.ts";
      const second = "file:///workspace-two/main.ts";
      yield* document.register({
        uri: first,
        snapshot: Effect.succeed(snapshot(first, "one")),
        changes: Stream.empty,
      });
      yield* document.register({
        uri: second,
        snapshot: Effect.succeed(snapshot(second, "two")),
        changes: Stream.empty,
      });
      yield* Effect.gen(function* () {
        yield* service.acquire({ uri: first, language: "typescript", workspace: "/workspace-one" });
        yield* service.acquire({
          uri: second,
          language: "typescript",
          workspace: "/workspace-two",
        });
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(LspService.layer({ catalog: builtInCatalog, spawn: fake.spawn })));
    expect(fake.pids).toEqual([1, 2]);
    expect(fake.closed).toEqual([2, 1]);
  }).pipe(Effect.scoped, provide),
);

tests.live(
  "decodeShowReferencesArgs reads vscode [uri, position, locations] at the wire boundary",
  Effect.sync(() => {
    const locations = [
      {
        uri: "file:///workspace/a.ts",
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 5 },
        },
      },
    ];
    expect(
      Option.getOrUndefined(
        decodeShowReferencesArgs(["file:///workspace/a.ts", { line: 1, character: 2 }, locations]),
      ),
    ).toEqual(locations);
    expect(Option.getOrUndefined(decodeShowReferencesArgs(["not", "a", "tuple"]))).toBeUndefined();
  }),
);
