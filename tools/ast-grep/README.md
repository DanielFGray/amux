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

`no-unknown-effect-channels.yml` reports `any` or `unknown` in the error or
requirements channels of qualified Effect data types. It covers `Effect`,
`Stream`, `Fiber`, `Deferred`, `FiberMap`, and `Cause`. It intentionally has no
automatic fix: the appropriate replacement is usually `never`, a domain error,
or a generic parameter, depending on the declaration.

Generic helpers should expose an `E` parameter instead of prescribing `any` or
`unknown`; public APIs should use a schema-typed tagged error or a concrete
error union.

Run it against the source tree with:

```bash
ast-grep scan \
  --rule tools/ast-grep/no-unknown-effect-channels.yml \
  src \
  --globs '**/*.ts' \
  --globs '**/*.tsx' \
  --report-style medium
```

The channel fixture contains concrete, generic, `never`, `any`, and `unknown`
examples. Scan it directly when changing the rule:

```bash
ast-grep scan \
  --rule tools/ast-grep/no-unknown-effect-channels.yml \
  tools/ast-grep/tests/no-unknown-effect-channels.ts \
  --report-style medium
```

The rule is deliberately structural. An inference helper that genuinely needs
an unconstrained channel should be reviewed at the call site rather than
excluded by a broad helper-name exception.

## Tagged-Union Branch Checks

`prefer-match-for-tag-check.yml` warns on a direct block or single-statement
`if` whose condition is `$value._tag === $tag`. It intentionally does not
match compound conditions, ternaries, collection predicates, or user-defined
type predicates: those often have a different control-flow shape and need
manual review.

Use `Match.value(value).pipe(Match.tag(tag, handler), Match.orElse(fallback))`
when handling one or a few selected cases. Use `Match.valueTags(value, fields)`
when the operation is naturally a direct tag-to-handler map. For a reusable
matcher, start with `Match.type<Union>()` and use `Match.tags(fields)` plus
`Match.exhaustive`; use `Match.tagsExhaustive(fields)` when the object map
itself should be the exhaustive matcher. `Match.tagStartsWith` is useful for
namespaced tags that share a prefix.

Dry-run it against the source tree with:

```bash
ast-grep scan \
  --rule tools/ast-grep/prefer-match-for-tag-check.yml \
  src \
  --globs '**/*.ts' \
  --report-style medium
```

This is a warning rule rather than a rewrite because choosing `orElse`,
`exhaustive`, or an explicit fallback depends on the surrounding control flow.

## Same-Value Nested Ternary Checks

`same-value-nested-ternary.yml` warns on a chain of `$A === $X ? ... : $A === $Y ? ...`
where the same expression is compared at least twice. The one caveat that keeps
it a warning rule: the pattern matches every depth of a chain, so a 4-arm chain
reports three matches. Act on the topmost one only.

The canonical replacements, by shape:

- Closed literal union (e.g. copy-mode `dir`): collect every arm and end with
  `Match.exhaustive` so adding a value to the union fails to compile:

  ```ts
  Match.value(dir).pipe(
    Match.when(Match.is("forward-start"), () => forwardWordStart(line, startAt)),
    Match.when(Match.is("forward-end"), () => forwardWordEnd(line, startAt)),
    Match.when(Match.is("backward-start"), () => backwardWordStart(line, startAt)),
    Match.exhaustive,
  );
  ```

- Untyped input or an opaque fallback (e.g. an OpenAI finish reason on a
  `string`): end with `Match.orElse`. Literal arms need `as const` — the
  contextual return type does not flow through `Match`'s generics, and the
  literals otherwise widen to `string`:

  ```ts
  Match.value(reason).pipe(
    Match.when(Match.is("stop"), () => "stop" as const),
    Match.when(Match.is("content_filter"), () => "content-filter" as const),
    Match.when(Match.is("tool_calls", "function_call"), () => "tool-calls" as const),
    Match.orElse(() => "unknown" as const),
  );
  ```

- Tagged-union dispatch inside an expression position (e.g. a stream frame
  switch that must yield an Effect): use `Match.tag` and keep an
  `Match.orElse(() => Effect.void)` default instead of folding a compound
  `_tag === x && field === y` check into a `when` predicate.

- Two+ values deriving one result are a lookup table, not `Match`. The old
  dock-resize `grows` cross-product of `side` and `direction` became
  `direction === DOCK_GROW_DIRECTION[side]`; a table also beats `Match` for a
  closed literal union that maps to plain functions.

- A two-branch comparison plus an identity default (e.g. `at === from ?
b : at === to ? a : pane` in a rewrite callback) stays a ternary.

- Effect-free packages (the editor, which deliberately depends only on
  `@opentui/core`) use a plain exhaustive `switch` over the closed union —
  do not pull `effect` into a package just for `Match`.

Do not write a blanket `-U` fix rule for this warning. Anchoring the pattern so
the else branch is not another ternary still rewrites the tail of a multi-level
chain and leaves a nested `Match.value` in the `orElse` body. The four shapes
above share no single rewrite, so review each occurrence by hand.

```bash
ast-grep scan \
  --rule tools/ast-grep/rules/same-value-nested-ternary.yml \
  packages \
  --globs '**/*.ts' \
  --report-style medium
```

Gotcha: a ternary pattern's `$A === $X ? $B : $A === $Y ? $D : $E` must be
single-quoted in YAML — the unquoted plain scalar parses the `: ` sequences as
nested mappings and the rule file fails to load.

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

## Effect v4 Error-Handler Rename

The direct v3-to-v4 rename from `Effect.catchAll` to `Effect.catch` is safe
only when ast-grep can match the complete call expression. Preview it first:

```bash
ast-grep run --lang ts \
  --pattern 'Effect.catchAll($HANDLER)' \
  --rewrite 'Effect.catch($HANDLER)' \
  packages --globs '**/*.ts' --globs '**/*.tsx'
```

In the Effect v4 migration this applied to 15 simple TypeScript call sites.
It did not cover TSX or syntactically nested call shapes; keep those for a
separate, reviewed pass rather than broadening the rule.

The same complete-call approach safely handled `Effect.catchAllCause` →
`Effect.catchCause`, `Effect.catchAllDefect` → `Effect.catchDefect`, and
generic `Effect.async<T>` → `Effect.callback<T>`. Non-generic callback calls
need their own preview pattern.

## Effect v4 Import Relocation

When an import map retains a module API, rewrite the entire import declaration
and preserve its clause. This successfully moved the simple `FileSystem` and
`PlatformError` imports to `effect/*`, and RPC imports to
`effect/unstable/rpc/*`. Do not apply this to the old `@effect/platform`
barrel when it imports several symbols: v4 splits that barrel by module, so
those declarations must be reviewed and divided manually.

`Context.Tag(id)<Self, Shape>()` has a uniform class-declaration rewrite to
`Context.Service<Self, Shape>()(id)`. It applied to 28 source/test service
definitions. Fixture source embedded in strings is not parsed by ast-grep and
must be updated separately.

## Reusable Effect v3 → v4 Suite

The `effect-v3-*.yml` rules package mappings which are syntax-preserving across
projects: `catchAll*`, `async`, `zipRight`, `Scope.extend`, interrupted-cause
checks, class-style `Context.Tag`, and `Effect.gen(this, ...)`. Preview each rule separately against a
small target first:

```bash
ast-grep scan --rule tools/ast-grep/rules/effect-v3-zip-right-to-and-then.yml src
```

Then inspect the generated diff before adding `--update-all`. The suite
intentionally excludes `Effect.Service`, broad `@effect/platform` barrel
imports, generic `Effect.gen(this, ...)`, and `Context.Tag` type annotations:
their v4 replacements require project-specific structure or type review.

The suite also includes exact barrel relocation rules for APIs that migrated
as a unit, such as `@effect/ai` → `effect/unstable/ai` and the individual RPC
modules. Keep provider packages such as `@effect/ai-anthropic` separate: they
remain external packages in v4.

## State Constant Rewrite

For a repeated property comparison, bind the receiver as a metavariable and
preview the exact AST rewrite before applying it:

```bash
ast-grep run --lang ts \
  --pattern '$OBJ.state === "blocked"' \
  --rewrite '$OBJ.state === AgentState.Blocked' \
  src --globs '**/*.ts' --globs '**/*.tsx' \
  --globs '!**/*.test.ts' --globs '!**/*.test.tsx'
```

The pattern matches the whole comparison, so it does not change unrelated
strings such as turn outcomes or comments. The replacement assumes the target
file already imports `AgentState`; add that import separately when required.

## Nullable-Field Migration

When a field becomes nullable (e.g. `Pane.session` is now `SessionHandle |
null`), the caller sites in tests can be migrated with two narrow rules:

```yaml
id: session-nullassert
language: TypeScript
rule:
  pattern: $PANE.session.$FIELD
fix: $PANE.session!.$FIELD
```

```yaml
id: session-const-nullassert
language: TypeScript
rule:
  pattern: const $NAME = $PANE.session;
fix: const $NAME = $PANE.session!;
```

The member-access rule handled ~60 call sites; the const-declaration rule
handled the rest (`const agent = pane.session;` → `... session!;`), which in
turn fixed the follow-on argument errors at those sites.

Gotchas learned on this migration:

- **`language: TypeScript` does not parse `.tsx`.** The member-access rule
  silently skipped `src/component-pane.test.tsx`; only the one remaining error
  there after the run revealed it. Fix those files by hand, or write the rule
  against TSX.
- The member-access pattern `$PANE.session.$FIELD` only fires when a field
  follows `.session`, so `content.session` (a `string` on a pane-content
  object) was never touched — but a bare `x.session` in a comparison or a Set
  literal is NOT matched and needs a separate pass (or manual edits).
- Run `bunx tsc --noEmit` between passes; the remaining errors tell you exactly
  which shapes the rules missed.
- These are one-off migrations: delete the rule files after the rewrite lands,
  keeping only the documentation of what worked.
