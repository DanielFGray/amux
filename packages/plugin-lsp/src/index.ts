import { Effect, Option } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { definePlugin, type PluginDefinition } from "@danielfgray/amux";
import { CONFIG_DIR } from "@danielfgray/amux/config.ts";
import { optionalEnvVar } from "@danielfgray/amux/session.ts";
import { catalogWithOverrides, loadCatalogOverrides } from "./catalog.ts";
import { DocumentService, makeDocumentService } from "./document.ts";
import { LspService } from "./service.ts";

export const LSP_PLUGIN_ID = "amux.lsp";

/**
 * Owns DocumentService + LspService for the client. Editors register live
 * buffers; harness and editor consume the typed per-document client. Spawning
 * a language server stays lazy until the first acquire for a (language, root).
 */
export const lspPlugin: PluginDefinition = definePlugin({
  id: LSP_PLUGIN_ID,
  provide: [DocumentService, LspService],
  effect: (ctx) =>
    Effect.gen(function* () {
      const session = Option.getOrUndefined(yield* optionalEnvVar("AMUX_SESSION"));
      const documents = yield* makeDocumentService({ session }).pipe(
        Effect.provide(BunServices.layer),
      );
      ctx.provide(DocumentService, documents);

      const overrides = yield* loadCatalogOverrides(`${CONFIG_DIR}/amux`).pipe(
        Effect.provide(BunServices.layer),
        Effect.orElseSucceed(() => ({ languages: {} })),
      );
      const service = yield* LspService.make({
        catalog: catalogWithOverrides(overrides),
      }).pipe(Effect.provideService(DocumentService, documents), Effect.provide(BunServices.layer));
      ctx.provide(LspService, service);
    }),
});

export {
  DocumentService,
  makeDocumentService,
  type DocumentServiceApi,
  type DocumentServiceOptions,
  type DocumentSnapshot,
  type LiveDocument,
} from "./document.ts";
export {
  LspService,
  LspServiceError,
  LspLocationSchema,
  LspPositionSchema,
  LspRangeSchema,
  ShowReferencesArgsSchema,
  decodeShowReferencesArgs,
  CodeActionItemSchema,
  isLspCommand,
  type LspDocumentClient,
  type LspDiagnostic,
  type LspDocument,
  type LspDocumentSymbol,
  type LspHover,
  type LspLocation,
  type LspTextEdit,
  type LspWorkspaceEdit,
  type LspCodeAction,
  type LspCodeActionItem,
  type LspCodeLens,
  type LspCommand,
  type LspSignatureHelp,
  type MarkedString,
  type MarkupContent,
  type LspCompletion,
  type LspCompletionItem,
  type LspCompletionList,
  type LspPosition,
  type LspRange,
  type LspServiceApi,
  type LspServiceOptions,
} from "./service.ts";
export type { LspNotification, LspTransport } from "./transport.ts";
export {
  builtInCatalog,
  catalogWithOverrides,
  languageForPath,
  loadCatalogOverrides,
  type LanguageCatalog,
} from "./catalog.ts";
export {
  decodeSemanticTokens,
  DEFAULT_SEMANTIC_TOKEN_TYPES,
  semanticGroupToHighlight,
  tokenCoverage,
  type SemanticTokenRange,
} from "./semantic-tokens.ts";
export default lspPlugin;
