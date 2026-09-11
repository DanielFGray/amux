# LSP plugin substrate

`@danielfgray/amux-plugin-lsp` provides the shared LSP services that editor and
agent plugins consume. It does not own an editor or an agent UI.

## Consumer seam

`LspService` is the shared substrate (editor and harness inject it; neither forks
its own client). Operational cycle:

1. **Provide buffers** — an editor (or harness fixture) `DocumentService.register`s
   a live document (`uri`, snapshot Effect, change stream). Unregistered URIs fall
   back to disk via `DocumentService.read`.
2. **Open** — under a `Scope`, `LspService.acquire({ uri, language, workspace })`
   returns an `LspDocumentClient`. That scopes a per-`(language, root)` server and
   a per-URI document reference (`didOpen`). Releasing the scope sends `didClose`
   and reaps the server when nothing else holds it.
3. **Apply edits** — publish a new snapshot on the registered change stream. The
   service forwards `didChange`; there is no separate apply-edit RPC on
   `LspService`.
4. **Query / drain** — typed client methods (`hover`, `definition`, `references`,
   `completion`, `symbols`, `semanticTokens`) and `client.diagnostics` (a stream
   filtered to that URI's `publishDiagnostics`).

Catalog and transport stay explicit `LspService.layer({ catalog, spawn? })`
inputs. Wire with `Effect.provide(Layer.merge(documentLayer, LspService.layer(...)))`.

The `amux.lsp` plugin (`src/index.ts`) provides both services for client plugins.
The agent harness constructs the same pair inside its daemon worker (client plugin
host is client-only). Editor soft-gets the services when the plugin is loaded.

## Highlighting

Live editor colors stay on tree-sitter (`@danielfgray/amux-highlight`). LSP
`semanticTokens/full` is exposed on `LspDocumentClient` and decoded by
`semantic-tokens.ts`, but is not the per-keystroke path — see ts-6b2753.

## Server catalog

The built-in catalog currently maps TypeScript files to:

```text
typescript-language-server --stdio
```

The host loads user definitions from `~/.config/amux/lsp.json` (or
`$XDG_CONFIG_HOME/amux/lsp.json`). An entry replaces all built-in settings for
that language, including server candidate order:

```json
{
  "languages": {
    "typescript": {
      "extensions": [".ts", ".tsx", ".mts", ".cts"],
      "servers": [{ "command": "tsgo", "args": ["--lsp"] }]
    },
    "go": {
      "extensions": [".go"],
      "servers": [{ "command": "gopls", "args": [] }]
    }
  }
}
```

To add a built-in language, add one language key to `src/catalog.ts` with its
extensions and ordered server candidates. The workspace root is always the
pane or space working directory; the catalog does not search for a VCS root.
