import { Context, Effect, Layer, Option, RcMap, Schema as S, Stream } from "effect";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { type LanguageCatalog, serverCommandsFor, workspaceRoot } from "./catalog.ts";
import { DocumentService, type DocumentServiceApi, type DocumentSnapshot } from "./document.ts";
import {
  type LspNotification,
  type LspTransport,
  LspTransportError,
  makeLspTransport,
} from "./transport.ts";

export class LspServiceError extends S.TaggedError<LspServiceError>()("LspServiceError", {
  message: S.String,
}) {}

export interface LspDocument {
  readonly uri: string;
  readonly language: string;
  readonly workspace: string;
}

/**
 * Opaque LSP JSON (LSPAny) kept as JSON text. The server owns its shape; code
 * that interprets a value decodes the text with that value's Schema (e.g.
 * ShowReferencesArgs).
 */
const LspJsonText = S.flip(S.fromJsonString(S.Unknown));
export type LspJsonText = typeof LspJsonText.Type;

export const LspPositionSchema = S.Struct({ line: S.Int, character: S.Int });
export type LspPosition = typeof LspPositionSchema.Type;
export const LspRangeSchema = S.Struct({ start: LspPositionSchema, end: LspPositionSchema });
export type LspRange = typeof LspRangeSchema.Type;

export const MarkedStringSchema = S.Union([
  S.String,
  S.Struct({ language: S.String, value: S.String }),
]);
export type MarkedString = typeof MarkedStringSchema.Type;

/** LSP MarkupContent — what typescript-language-server returns for hover. */
export const MarkupContentSchema = S.Struct({
  kind: S.Literals(["plaintext", "markdown"]),
  value: S.String,
});
export type MarkupContent = typeof MarkupContentSchema.Type;

const HoverContentsSchema = S.Union([
  MarkedStringSchema,
  S.Array(MarkedStringSchema),
  MarkupContentSchema,
]);

const HoverSchema = S.Struct({
  contents: HoverContentsSchema,
  range: S.optional(LspRangeSchema),
});
export type LspHover = typeof HoverSchema.Type;

const LocationSchema = S.Struct({ uri: S.String, range: LspRangeSchema });
const DefinitionSchema = S.Union([LocationSchema, S.Array(LocationSchema)]);
export const LspLocationSchema = LocationSchema;
export type LspLocation = typeof LocationSchema.Type;

const CompletionItemSchema = S.Struct({
  label: S.String,
  kind: S.optional(S.Int),
  detail: S.optional(S.String),
  documentation: S.optional(S.Union([S.String, MarkedStringSchema, MarkupContentSchema])),
});
export type LspCompletionItem = typeof CompletionItemSchema.Type;
const CompletionListSchema = S.Struct({
  isIncomplete: S.Boolean,
  items: S.Array(CompletionItemSchema),
});
export type LspCompletionList = typeof CompletionListSchema.Type;
const CompletionSchema = S.Union([CompletionListSchema, S.Array(CompletionItemSchema)]);
export type LspCompletion = typeof CompletionSchema.Type;

export interface LspDocumentSymbol {
  readonly name: string;
  readonly kind: number;
  readonly range: LspRange;
  readonly selectionRange: LspRange;
  readonly detail?: string;
  readonly children?: readonly LspDocumentSymbol[];
}

const DocumentSymbolSchema: S.Codec<LspDocumentSymbol> = S.Struct({
  name: S.String,
  kind: S.Int,
  range: LspRangeSchema,
  selectionRange: LspRangeSchema,
  detail: S.optional(S.String),
  children: S.optional(S.Array(S.suspend(() => DocumentSymbolSchema))),
});

const DiagnosticSchema = S.Struct({
  range: LspRangeSchema,
  message: S.String,
  severity: S.optional(S.Int),
  source: S.optional(S.String),
  code: S.optional(S.Union([S.Int, S.String])),
});
export type LspDiagnostic = typeof DiagnosticSchema.Type;

/** Active signature help payload (`textDocument/signatureHelp`). */
export interface LspSignatureHelp {
  readonly signatures: readonly {
    readonly label: string;
    readonly documentation?: string | MarkedString | MarkupContent;
  }[];
  readonly activeSignature?: number;
  readonly activeParameter?: number;
}

const SignatureInformationSchema = S.Struct({
  label: S.String,
  documentation: S.optional(S.Union([S.String, MarkedStringSchema, MarkupContentSchema])),
});

const SignatureHelpSchema = S.Struct({
  signatures: S.Array(SignatureInformationSchema),
  activeSignature: S.optional(S.Int),
  activeParameter: S.optional(S.Int),
});

const DiagnosticsSchema = S.Struct({ uri: S.String, diagnostics: S.Array(DiagnosticSchema) });
const SemanticTokensSchema = S.Struct({ data: S.Array(S.Int) });
export type LspSemanticTokens = typeof SemanticTokensSchema.Type;

const TextEditSchema = S.Struct({
  range: LspRangeSchema,
  newText: S.String,
});
export type LspTextEdit = typeof TextEditSchema.Type;

const TextDocumentEditSchema = S.Struct({
  textDocument: S.Struct({ uri: S.String, version: S.optional(S.Union([S.Int, S.Null])) }),
  edits: S.Array(TextEditSchema),
});

const WorkspaceEditSchema = S.Struct({
  changes: S.optional(S.Record(S.String, S.Array(TextEditSchema))),
  documentChanges: S.optional(S.Array(TextDocumentEditSchema)),
});
export type LspWorkspaceEdit = typeof WorkspaceEditSchema.Type;

const CommandSchema = S.Struct({
  title: S.String,
  command: S.String,
  arguments: S.optional(LspJsonText),
});
/** LSP Command — title is what nvim virt-text / pickers show. */
export type LspCommand = typeof CommandSchema.Type;

/**
 * CodeAction (not a bare Command). `command` here is nested Command object.
 * Cite: LSP CodeAction; nvim buf.lua on_user_choice distinguishes Command vs CodeAction
 * by whether `action.command` is a string.
 */
const CodeActionSchema = S.Struct({
  title: S.String,
  kind: S.optional(S.String),
  edit: S.optional(WorkspaceEditSchema),
  command: S.optional(CommandSchema),
  disabled: S.optional(S.Struct({ reason: S.String })),
  data: S.optional(LspJsonText),
});
export type LspCodeAction = typeof CodeActionSchema.Type;

/**
 * textDocument/codeAction items: Command | CodeAction.
 * Cite: neovim buf.lua — "can return either Command[] or CodeAction[]".
 */
export const CodeActionItemSchema = S.Union([CommandSchema, CodeActionSchema]);
export type LspCodeActionItem = typeof CodeActionItemSchema.Type;

/** True when the item is a bare Command (command field is a string). */
export const isLspCommand = (action: LspCodeActionItem): action is LspCommand =>
  S.is(CommandSchema)(action);

/**
 * vscode `editor.action.showReferences` / `*.showReferences` args.
 * Cite: vscode Command `[uri, position, Location[]]`.
 */
export const ShowReferencesArgsSchema = S.Tuple([
  S.String,
  LspPositionSchema,
  S.Array(LspLocationSchema),
]);

/** Decode showReferences command arguments (JSON text) at the use site. */
export const decodeShowReferencesArgs = (
  args: string | undefined,
): Option.Option<readonly LspLocation[]> =>
  Option.flatMap(Option.fromUndefinedOr(args), (text) =>
    Option.map(S.decodeOption(S.fromJsonString(ShowReferencesArgsSchema))(text), (decoded) => decoded[2]),
  );

const CodeLensSchema = S.Struct({
  range: LspRangeSchema,
  command: S.optional(CommandSchema),
  data: S.optional(LspJsonText),
});
/** textDocument/codeLens item. Unresolved lenses omit `command` until resolve. */
export type LspCodeLens = typeof CodeLensSchema.Type;

const TextDocumentIdentifier = S.Struct({ uri: S.String });
const TextDocumentPositionParams = S.Struct({
  textDocument: TextDocumentIdentifier,
  position: LspPositionSchema,
});
const TextDocumentParams = S.Struct({ textDocument: TextDocumentIdentifier });
const EmptyObjectSchema = S.Struct({});

export const InitializeParamsSchema = S.Struct({
  processId: S.NullOr(S.Int),
  rootUri: S.NullOr(S.String),
  capabilities: EmptyObjectSchema,
  workspaceFolders: S.optional(S.Array(S.Struct({ uri: S.String, name: S.String }))),
});
export const InitializeResultSchema = S.Struct({ capabilities: EmptyObjectSchema });

const ReferencesParamsSchema = S.Struct({
  textDocument: TextDocumentIdentifier,
  position: LspPositionSchema,
  context: S.Struct({ includeDeclaration: S.Boolean }),
});
const RenameParamsSchema = S.Struct({
  textDocument: TextDocumentIdentifier,
  position: LspPositionSchema,
  newName: S.String,
});
const CodeActionParamsSchema = S.Struct({
  textDocument: TextDocumentIdentifier,
  range: LspRangeSchema,
  context: S.Struct({ diagnostics: S.Array(DiagnosticSchema) }),
});
const ExecuteCommandParamsSchema = S.Struct({
  command: S.String,
  arguments: S.optional(LspJsonText),
});
const DidOpenParamsSchema = S.Struct({
  textDocument: S.Struct({
    uri: S.String,
    languageId: S.String,
    version: S.Int,
    text: S.String,
  }),
});
const DidChangeParamsSchema = S.Struct({
  textDocument: S.Struct({ uri: S.String, version: S.Int }),
  contentChanges: S.Array(S.Struct({ text: S.String })),
});
const DidCloseParamsSchema = S.Struct({ textDocument: TextDocumentIdentifier });

export interface LspDocumentClient {
  readonly hover: (
    position: LspPosition,
  ) => Effect.Effect<Option.Option<LspHover>, LspServiceError>;
  readonly definition: (
    position: LspPosition,
  ) => Effect.Effect<Option.Option<LspLocation | readonly LspLocation[]>, LspServiceError>;
  /** textDocument/declaration — many servers omit this; fall back to definition at the call site. */
  readonly declaration: (
    position: LspPosition,
  ) => Effect.Effect<Option.Option<LspLocation | readonly LspLocation[]>, LspServiceError>;
  readonly typeDefinition: (
    position: LspPosition,
  ) => Effect.Effect<Option.Option<LspLocation | readonly LspLocation[]>, LspServiceError>;
  readonly implementation: (
    position: LspPosition,
  ) => Effect.Effect<Option.Option<LspLocation | readonly LspLocation[]>, LspServiceError>;
  readonly references: (
    position: LspPosition,
  ) => Effect.Effect<readonly LspLocation[], LspServiceError>;
  readonly rename: (
    position: LspPosition,
    newName: string,
  ) => Effect.Effect<Option.Option<LspWorkspaceEdit>, LspServiceError>;
  readonly completion: (
    position: LspPosition,
  ) => Effect.Effect<Option.Option<LspCompletion>, LspServiceError>;
  readonly signatureHelp: (
    position: LspPosition,
  ) => Effect.Effect<Option.Option<LspSignatureHelp>, LspServiceError>;
  readonly codeAction: (
    range: LspRange,
    context?: { readonly diagnostics?: readonly LspDiagnostic[] },
  ) => Effect.Effect<readonly LspCodeActionItem[], LspServiceError>;
  /** Fill deferred edit/command (`codeAction/resolve`). Cite: nvim on_user_choice. */
  readonly resolveCodeAction: (
    action: LspCodeAction,
  ) => Effect.Effect<Option.Option<LspCodeAction>, LspServiceError>;
  /** All code lenses for the document (`textDocument/codeLens`). */
  readonly codeLenses: Effect.Effect<readonly LspCodeLens[], LspServiceError>;
  /** Fill in `command` when the server deferred it (`codeLens/resolve`). */
  readonly resolveCodeLens: (
    lens: LspCodeLens,
  ) => Effect.Effect<Option.Option<LspCodeLens>, LspServiceError>;
  /** Run a server-side command (`workspace/executeCommand`). Result is opaque JSON text. */
  readonly executeCommand: (
    command: LspCommand,
  ) => Effect.Effect<Option.Option<LspJsonText>, LspServiceError>;
  readonly symbols: Effect.Effect<readonly LspDocumentSymbol[], LspServiceError>;
  readonly semanticTokens: Effect.Effect<Option.Option<LspSemanticTokens>, LspServiceError>;
  /** Each element is one `publishDiagnostics` payload for this URI (full replace). */
  readonly diagnostics: Stream.Stream<readonly LspDiagnostic[], LspServiceError>;
}

export interface LspServiceApi {
  readonly acquire: (
    document: LspDocument,
  ) => Effect.Effect<
    LspDocumentClient,
    LspServiceError,
    Scope.Scope | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
}

/** Shared client-side LSP servers. Caller scopes own document references. */
export class LspService extends Context.Service<LspService, LspServiceApi>()(
  "amux.lsp/LspService",
) {
  static readonly make = Effect.fnUntraced(function* (options: LspServiceOptions) {
    const documents = yield* DocumentService;
    const spawn = options.spawn ?? makeLspTransport;
    const servers = yield* RcMap.make({
      lookup: (key: string) => makeServer(key, options.catalog, documents, spawn),
    });
    return LspService.of({
      acquire: Effect.fnUntraced(function* (document: LspDocument) {
        const root = yield* workspaceRoot(document.workspace);
        const server = yield* RcMap.get(servers, `${document.language}\u0000${root}`);
        yield* RcMap.get(server.documents, document.uri);
        return makeClient(server.transport, document.uri);
      }),
    });
  });

  static readonly layer = (options: LspServiceOptions) =>
    Layer.effect(LspService, LspService.make(options));
}

export interface LspServiceOptions {
  readonly catalog: LanguageCatalog;
  readonly spawn?: (options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }) => Effect.Effect<
    LspTransport,
    LspTransportError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
}

const makeServer = Effect.fnUntraced(function* (
  key: string,
  catalog: LanguageCatalog,
  documents: DocumentServiceApi,
  spawn: NonNullable<LspServiceOptions["spawn"]>,
) {
  const separator = key.indexOf("\u0000");
  const language = key.slice(0, separator);
  const root = key.slice(separator + 1);
  const commands = Option.getOrUndefined(serverCommandsFor(catalog, language));
  const command = commands?.[0];
  if (command === undefined)
    return yield* new LspServiceError({ message: `no LSP server configured for ${language}` });
  const transport = yield* spawn({ ...command, cwd: root }).pipe(
    Effect.mapError((error) => new LspServiceError({ message: error.message })),
  );
  yield* transport
    .request(
      "initialize",
      { processId: null, rootUri: `file://${root}`, capabilities: {} },
      InitializeParamsSchema,
      InitializeResultSchema,
    )
    .pipe(Effect.mapError((error) => new LspServiceError({ message: error.message })));
  yield* transport
    .notify("initialized", {}, EmptyObjectSchema)
    .pipe(Effect.mapError((error) => new LspServiceError({ message: error.message })));
  const documentMap = yield* RcMap.make({
    lookup: (uri: string) => openDocument(uri, language, documents, transport),
  });
  return { transport, documents: documentMap };
});

const openDocument = Effect.fnUntraced(function* (
  uri: string,
  language: string,
  documents: DocumentServiceApi,
  transport: LspTransport,
) {
  let version = 1;
  const snapshot = yield* documents.read({ uri, language }).pipe(Effect.mapError(asServiceError));
  yield* notifyOpen(transport, snapshot, version);
  yield* Effect.forkScoped(
    documents.changes(uri).pipe(
      Stream.runForEach((next) => {
        version += 1;
        return transport
          .notify(
            "textDocument/didChange",
            {
              textDocument: { uri, version },
              contentChanges: [{ text: next.text }],
            },
            DidChangeParamsSchema,
          )
          .pipe(Effect.mapError(asServiceError));
      }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    transport
      .notify("textDocument/didClose", { textDocument: { uri } }, DidCloseParamsSchema)
      .pipe(Effect.ignore),
  );
});

const notifyOpen = (transport: LspTransport, snapshot: DocumentSnapshot, version: number) =>
  transport
    .notify(
      "textDocument/didOpen",
      {
        textDocument: {
          uri: snapshot.uri,
          languageId: snapshot.language,
          version,
          text: snapshot.text,
        },
      },
      DidOpenParamsSchema,
    )
    .pipe(Effect.mapError(asServiceError));

const asServiceError = (error: { readonly message: string }) =>
  new LspServiceError({ message: error.message });

const request = <A, I, O, OI>(
  transport: LspTransport,
  method: string,
  params: A,
  paramsSchema: S.Codec<A, I>,
  resultSchema: S.Codec<O, OI>,
) =>
  transport
    .request(method, params, paramsSchema, resultSchema)
    .pipe(Effect.mapError(asServiceError));

const makeClient = (transport: LspTransport, uri: string): LspDocumentClient => {
  const textDocument = { textDocument: { uri } };
  const at = (position: LspPosition) => ({ textDocument: { uri }, position });
  const optional = <A, I, O, OI>(
    method: string,
    params: A,
    paramsSchema: S.Codec<A, I>,
    resultSchema: S.Codec<O, OI>,
  ) => request(transport, method, params, paramsSchema, S.OptionFromNullOr(resultSchema));
  return {
    hover: (position) => optional("textDocument/hover", at(position), TextDocumentPositionParams, HoverSchema),
    definition: (position) =>
      optional("textDocument/definition", at(position), TextDocumentPositionParams, DefinitionSchema),
    declaration: (position) =>
      optional("textDocument/declaration", at(position), TextDocumentPositionParams, DefinitionSchema),
    typeDefinition: (position) =>
      optional(
        "textDocument/typeDefinition",
        at(position),
        TextDocumentPositionParams,
        DefinitionSchema,
      ),
    implementation: (position) =>
      optional(
        "textDocument/implementation",
        at(position),
        TextDocumentPositionParams,
        DefinitionSchema,
      ),
    references: (position) =>
      request(
        transport,
        "textDocument/references",
        { textDocument: { uri }, position, context: { includeDeclaration: true } },
        ReferencesParamsSchema,
        S.OptionFromNullOr(S.Array(LocationSchema)),
      ).pipe(Effect.map((value) => Option.getOrElse(value, () => []))),
    rename: (position, newName) =>
      optional(
        "textDocument/rename",
        { textDocument: { uri }, position, newName },
        RenameParamsSchema,
        WorkspaceEditSchema,
      ),
    completion: (position) =>
      optional("textDocument/completion", at(position), TextDocumentPositionParams, CompletionSchema),
    signatureHelp: (position) =>
      optional(
        "textDocument/signatureHelp",
        at(position),
        TextDocumentPositionParams,
        SignatureHelpSchema,
      ),
    codeAction: (range, context) =>
      request(
        transport,
        "textDocument/codeAction",
        {
          textDocument: { uri },
          range,
          context: { diagnostics: context?.diagnostics ?? [] },
        },
        CodeActionParamsSchema,
        S.OptionFromNullOr(S.Array(CodeActionItemSchema)),
      ).pipe(Effect.map((value) => Option.getOrElse(value, () => []))),
    resolveCodeAction: (action) =>
      optional("codeAction/resolve", action, CodeActionSchema, CodeActionSchema),
    codeLenses: request(
      transport,
      "textDocument/codeLens",
      textDocument,
      TextDocumentParams,
      S.OptionFromNullOr(S.Array(CodeLensSchema)),
    ).pipe(Effect.map((value) => Option.getOrElse(value, () => []))),
    resolveCodeLens: (lens) => optional("codeLens/resolve", lens, CodeLensSchema, CodeLensSchema),
    executeCommand: (command) =>
      optional(
        "workspace/executeCommand",
        {
          command: command.command,
          arguments: command.arguments,
        },
        ExecuteCommandParamsSchema,
        LspJsonText,
      ),
    symbols: request(
      transport,
      "textDocument/documentSymbol",
      textDocument,
      TextDocumentParams,
      S.OptionFromNullOr(S.Array(DocumentSymbolSchema)),
    ).pipe(Effect.map((value) => Option.getOrElse(value, () => []))),
    semanticTokens: optional(
      "textDocument/semanticTokens/full",
      textDocument,
      TextDocumentParams,
      SemanticTokensSchema,
    ),
    diagnostics: transport.notifications.pipe(
      Stream.filter((notification) => notification.method === "textDocument/publishDiagnostics"),
      Stream.mapEffect((notification: LspNotification) =>
        Option.match(
          S.decodeOption(S.fromJsonString(S.Struct({ params: DiagnosticsSchema })))(
            notification.frameJson,
          ),
          {
            onNone: () => Effect.fail(new LspServiceError({ message: "invalid diagnostics" })),
            onSome: (message) => Effect.succeed(message.params),
          },
        ),
      ),
      Stream.filter((value) => value.uri === uri),
      Stream.map((value) => value.diagnostics),
    ),
  };
};
