import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { testEffect } from "../../amux/src/test-effect.ts";
import { LspTransportError, makeLspTransport } from "./transport.ts";

const server = Bun.which("typescript-language-server");

if (server === null) {
  test.skip("typescript-language-server is required for the LSP transport spike", () => {});
} else {
  testEffect(
    "initializes, opens a TypeScript document, and is killed with its scope",
    Effect.gen(function* () {
      const pid = yield* Effect.scoped(
        Effect.gen(function* () {
          const lsp = yield* makeLspTransport({
            command: server,
            args: ["--stdio"],
            cwd: process.cwd(),
          });
          const rootUri = `file://${process.cwd()}`;
          const uri = `${rootUri}/packages/editor/src/lsp-transport-spike.ts`;
          const initialized = yield* Effect.timeoutOrElse(
            lsp.request("initialize", {
              processId: null,
              rootUri,
              capabilities: {},
              workspaceFolders: [{ uri: rootUri, name: "amux" }],
            }),
            {
              duration: "5 seconds",
              orElse: () => new LspTransportError({ message: "initialize timed out" }),
            },
          );
          expect(initialized).toMatchObject({ capabilities: expect.any(Object) });
          yield* lsp.notify("initialized", {});
          yield* lsp.notify("textDocument/didOpen", {
            textDocument: {
              uri,
              languageId: "typescript",
              version: 1,
              text: "export const answer: string = 42;\n",
            },
          });
          const symbols = yield* Effect.timeoutOrElse(
            lsp.request("textDocument/documentSymbol", { textDocument: { uri } }),
            {
              duration: "5 seconds",
              orElse: () => new LspTransportError({ message: "documentSymbol timed out" }),
            },
          );
          expect(symbols).toMatchObject([{ name: "answer" }]);
          return lsp.pid;
        }).pipe(Effect.provide(BunServices.layer)),
      );
      expect(pid).toBeGreaterThan(0);
      yield* Effect.sleep("50 millis");
      const probe = Bun.spawn(["kill", "-0", String(pid)], { stderr: "ignore" });
      const exitCode = yield* Effect.promise(() => probe.exited);
      expect(exitCode).not.toBe(0);
    }),
    { timeout: 30_000 },
  );
}
