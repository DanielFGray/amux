# Plugin lifecycle simplification

The Cordis paper makes ownership of inverses and dependency-driven activation
the runtime's responsibilities. In amux, those responsibilities already live
in the Effect plugin host and its contribution tables. Pane view registration
had acquired a second runtime that duplicated cleanup without managing any
dependencies used by the application.

The caller's contract stays synchronous:

```ts
const dispose = views.register(owner, "chat", view);
dispose();
const disposeNext = views.register(owner, "chat", nextView);
dispose(); // Must not withdraw nextView.
disposeNext();
```

`SessionViews.register` now uses `ContributionTable.add` directly. The table
owns registration identity, duplicate detection, generation visibility, and
idempotent disposal. `scopedRegistry` binds the returned disposer to the
plugin's Effect scope. The host closes that scope during removal or replacement.
Solid reads the committed table entry when rendering a pane.

The alternative was to repair `ComponentRuntime` and make registration await
its teardown. That would either change the synchronous interface or retain two
independent records of one registration. No production caller used its service
graph, so removing it concentrates ownership without reducing plugin capability.
Its implementation and isolated tests were removed after checking all references.
The pane-view regression proves that immediate reuse works and that a stale
disposer leaves the replacement alone. Existing host and service tests exercise
scope cleanup, dependency ordering, and provider replacement.

The host also recorded a replacement definition before knowing whether it
started. A failed candidate kept the previous generation running, but retrying
the same definition did nothing because reconciliation considered it current.
Reconciliation now updates that record only after `addPlugin` succeeds. A test
fails the first replacement attempt, confirms the original scope survives,
then retries the same definition and confirms the original scope closes.

This pass does not establish full Cordis conformance. The task list already
tracks target-view lifecycle handling, failed plugin state, and coeffect realms.
Those should extend the host's single lifecycle implementation. Reintroducing
an independent runtime around individual registries would require a concrete
capability that the existing scope and contribution table cannot express.
