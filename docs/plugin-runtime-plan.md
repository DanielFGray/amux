# Plugin runtime refactor

- [x] Ground: trace host activation, service acquisition, generation visibility, and command dispatch.
- [x] Sketch: compare snapshot acquisition with validating sequential acquisition.
- [x] Agree: proceed under the requested refactor authorization.
- [x] Implement: coherent dependencies, shared generation ownership, explicit lifecycle, unified commands.
- [x] Scrap/review: check the implementation against lifecycle races and remove superseded paths.

Implementation notes from the review pass:

- `submit` (host.ts) queued every host operation, including `dispose`, onto
  the same `operations` queue that a background fiber drains. Disposal
  interrupts that fiber once its own finalizer runs, so a second `dispose`
  (or any call arriving after teardown) queued into a channel nobody would
  ever read from again and hung forever. `submit` now runs its operation
  inline once `disposed` is true instead of enqueueing it.
- `status()` intentionally now reports failed and replacement plugins by
  design (`PluginStatus.phase`), which is new: several existing tests
  asserted the old behavior of dropping a failed plugin from `status()`
  entirely. Updated those assertions to expect the failed entry with its
  `error`, rather than treating the visibility as a regression.
- The host now routes activation completion through an internal
  `operations` queue rather than resolving inline, so a test observing the
  effects of a crash needs a few more cooperative yields than before that
  indirection existed.

Callers continue to declare `inject: [A, B]` and acquire both inside the plugin
Effect. They must receive services that were available together, even when A
changes while B is missing. Plugin authors do not coordinate retries.

The chosen dependency design waits for registry changes while any dependency
is missing, then captures the complete view synchronously. It records provider
identity before activation so teardown can find every consumer. Sequential
acquisition followed by validation would also work, but retains partial state
and requires a second pass to prove that state is still valid.

Generation visibility belongs to the contribution registry. Services read that
same authority and react to its changes; the host commits or retires a generation
once. This preserves separate storage for service values and UI contributions.

Lifecycle changes must preserve private replacement activation, failed-reload
rollback, and dependent-first teardown. Explicit states should own resources
and retained failures, with configuration changes ordered by the host. A full
replacement runtime would duplicate established Effect scope behavior; the
design instead keeps scope ownership inside this host.

Command dispatch will use one registry seeded with built-ins. Static command
types remain authoring conveniences; lookup, listing, routing metadata, and
disposal use the registry. No workspace mutation moves into the client.
