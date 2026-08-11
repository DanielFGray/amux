A terminal multiplexer with agent-aware features. Daemon/client architecture: the daemon owns PTYs and workspace state; clients attach over Unix sockets and project the model into OpenTUI renderables. Built with Effect, OpenTUI+Solid, using libghostty-vt via Bun FFI.

## Architectural invariants

These rules must not be violated — the dead "second authority" in the client
exists because they were once broken:

- The daemon owns all PTYs and workspace state. The client is a read-only projection. Never mutate workspace state in `Window`, `Space`, or `Pane`.
- All workspace mutations go through ordered commands via the daemon's model queue. A client-side mutation will diverge from the daemon's generation.
- Newline-framed JSON over Unix sockets. Terminal bytes (input/output) are base64-encoded within frames. Workspace frames embed full JSON snapshots.
- State persistence is write-temp-then-rename (atomic against process crash). Durability obligations in the daemon treat a completed write as discharged. `ARCHITECTURE.md` documents the transaction ordering in detail.
- **Core is agent-AWARE, not an agent.** Core knows a pane is running claude/codex/opencode and what state it is in. It must never contain a provider, model, credential, prompt, or turn loop. An agent _harness_ is a plugin — including ours. See `ARCHITECTURE.md` and `ts-8305f4`.

Full architecture is in ARCHITECTURE.md — read it before touching the daemon or
workspace model.

## Vocabulary

session: daemon-owned backend (supervised PTY today, agent later)
pane: view of a session in a layout
agent: LLM coding agent — never the supervised PTY
harness: the thing that runs an agent's turn loop. Always a plugin, never core
workspace: renderer-free transform model (the thing the daemon owns)

## Code conventions

- Combine overlapping concepts. Break modules that own many concepts apart.
- Derivable state must not be stored separately. If X can be computed from Y, don't store X.
- No backwards compatibility with unshipped code. Delete old paths, update all callers.
- Comments explain constraints the code cannot show. If the code is self-evident, the comment is noise.

## Working with this project

Before performing multiple mechanical rewrites, read
`tools/ast-grep/README.md`. Keep transformations narrow, dry-run them first,
and add newly discovered ast-grep examples and gotchas to that document.

```bash
bun test src          # unit tests
bun test e2e          # e2e tests (slower, requires daemon)
bunx tsc --noEmit     # typecheck
bun run start         # client (same as `bun src/cli.ts <session>`)
bun run daemon        # daemon (same as `bun src/cli.ts daemon <session>`)
bun run cli           # unified `amux` CLI entry
```

TypeScript diagnostics include suggestions. Treat suggestions as actionable
feedback: fix them when they are correct, and do not suppress or ignore them
until they accumulate.

Tasks live in `prog`:

```bash
prog prime            # workflow context
prog ready -p amux    # unblocked tasks
```

## Gotchas

- `Effect.gen`'s `try/catch` does NOT catch typed Effect failures. Use `Effect.catchAll` or `Effect.catchTags`.
- Never `Effect.runSync` on an effect crossing an async boundary (daemon RPC). Use fire-and-forget with failure logging (see `runDetached` pattern).
- Socket framing: split on newline **bytes** before decoding to UTF-8. Decoding a partial chunk silently mangles multibyte characters (U+FFFD).
- Shim C code: PTY master fds need `FD_CLOEXEC`. Bun FFI arguments (Uint8Array raw addresses) need a live reference after the FFI call (GC pinning).
- libghostty-vt's grapheme codepoint API writes unboundedly into the caller buffer — use the `graphemes_utf8` data kind which has built-in bounds checking.

## Referenced projects

- ../herdr/ - the rust project we are cloning to match features
- ../cmux/ - similar agent-aware multiplexor in swift
- ../opencode/ — opentui + effect-ts agent harness
- ../zaly/ — example agent harness on an inhouse stack
- ../opentui/ - opentui source including lots of examples
- ../tsdoctor/ — TypeScript LSP features from CLI, very helpful when debugging type issues
