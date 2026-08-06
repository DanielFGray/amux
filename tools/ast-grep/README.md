# Ast-Grep Examples

Ast-grep is useful here for small, syntax-preserving migrations where every
match has the same meaning. Keep rules narrow, run them against named files or
small globs, and inspect the proposed diff before applying anything.

Agents should update this document liberally as they use ast-grep. Add useful
commands, representative examples, and gotchas whenever a rule succeeds,
fails, or needs a narrower scope. This document is the shared working record
for making future transformations safer and more effective.

## Dry Runs

`ast-grep scan` prints proposed replacements by default. Do not pass
`--update-all` when exploring a rule.

Run the existing Effect wrapper rule against one file:

```bash
ast-grep scan \
  --rule tools/ast-grep/effect-run-promise-to-yield.yml \
  src/effect/SessionRegistry.test.ts \
  --report-style medium
```

Run it against a selected group of files:

```bash
ast-grep scan \
  --rule tools/ast-grep/effect-run-promise-to-yield.yml \
  src/effect/SessionRegistry.test.ts \
  src/effect/AttachHub.test.ts
```

Limit a directory with a glob and only print matching paths:

```bash
ast-grep scan \
  --rule tools/ast-grep/effect-run-promise-to-yield.yml \
  src \
  --globs '**/effect/*.test.ts' \
  --files-with-matches
```

The rewrite preview is also available with `ast-grep run`. Omitting
`--update-all` keeps this as a dry run:

```bash
ast-grep run \
  --lang ts \
  --pattern 'import { $$$NAMES } from "bun:test"' \
  --rewrite 'import { $$$NAMES } from "vitest"' \
  src/effect/SessionRegistry.test.ts
```

## Safe Import Rewrite

The whole import declaration is a valid AST pattern, so this is suitable for
the mechanical part of the Bun-to-Vitest migration:

```yaml
id: bun-test-to-vitest
language: TypeScript
rule:
  pattern: import $$$CLAUSE from "bun:test"
fix: import $$$CLAUSE from "vitest"
```

The named-import form can be tested inline:

```bash
ast-grep run \
  --lang ts \
  --pattern 'import { $$$NAMES } from "bun:test"' \
  --rewrite 'import { $$$NAMES } from "vitest"' \
  src/ui/state.test.ts
```

Do not use `from "bun:test"` as the pattern. It is a source fragment made of
multiple AST nodes, not one replaceable node, and ast-grep rejects it.

## Diagnostic-Only Rules

Use a rule without `fix` when the match needs semantic review. This finds
`Effect.runSync` calls in tests without proposing an unsafe replacement:

```bash
ast-grep scan --inline-rules $'\
id: sync-effect-in-test\n\
language: TypeScript\n\
severity: hint\n\
message: Effect.runSync in a test requires manual Effect test conversion\n\
rule:\n\
  pattern: Effect.runSync($E)' \
  src/ui/frame.test.tsx src/ui/state.test.ts \
  --report-style medium
```

This finds legacy daemon starts in tests, if any remain:

```bash
ast-grep scan --inline-rules $'\
id: legacy-daemon-start\n\
language: TypeScript\n\
severity: hint\n\
message: Inspect legacy daemon start call\n\
rule:\n\
  pattern: $DAEMON.start()' \
  src --globs '**/*.test.ts' \
  --report-style medium
```

Diagnostic rules are preferable for `Effect.runSync`, daemon lifecycle calls,
and Promise conversions. The correct replacement depends on whether the
surrounding function must become `it.effect`, `it.scoped`, or remain a normal
Vitest test.

## Effect Channel Checks

`no-unknown-effect-channels.yml` reports `unknown` in either the error or
requirements channel of a qualified `Effect.Effect` type. It intentionally has
no automatic fix: the appropriate replacement is usually `never`, a domain
error, or a generic parameter, depending on the declaration.

Run it against the source tree with:

```bash
ast-grep scan \
  --rule tools/ast-grep/no-unknown-effect-channels.yml \
  src \
  --globs '**/*.ts' \
  --globs '**/*.tsx' \
  --report-style medium
```

The rule is deliberately structural. An inference helper that genuinely needs
an unconstrained channel should be reviewed at the call site rather than
excluded by a broad helper-name exception.

## Applying A Reviewed Rule

Only after reviewing the dry-run output should a rule be applied:

```bash
ast-grep scan \
  --rule tools/ast-grep/bun-test-to-vitest.yml \
  src/effect/SessionRegistry.test.ts \
  --update-all
```

Keep the scope narrow, then run formatting, typecheck, and the affected tests.

The installed ast-grep CLI accepts `--lang` on `ast-grep run`, but not on
`ast-grep scan` in this environment; use `ast-grep run` for a syntax rewrite
and inspect its preview before adding `--update-all`.
