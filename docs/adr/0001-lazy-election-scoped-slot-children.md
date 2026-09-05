# Chain-slot children declare lazily, scoped to election

The frame-arrangement design (ep-e09db9, ts-8b6474) models amux's slot registry on
deepseek-harness's `ui-slots`, whose `chain` kind lets multiple candidates
register with a selector and elects one at render time — the mechanism chosen
for amux's root slot, so several frame plugins can compete on live context
(terminal size, workspace, session count) rather than a static config priority.

`ui-slots` declares a registrant's child slots *eagerly, at `register()` time*,
regardless of whether that entry is ever elected. That's harmless for
single/keyed/list slots, where exactly one entry ever occupies a name. For
`chain`, every candidate registers up front, so two frame plugins wanting the
same conventional child-slot name (e.g. `top.app`, so a third-party status-bar
plugin works under either frame) would collide at load time under the literal
`ui-slots` model, even though only one is ever shown.

Decided: amux's registry declares a chain candidate's children only while it
is the currently elected occupant, un-declaring and re-declaring as election
changes. This is a deliberate departure from `ui-slots`' reference behavior,
not a straight port.

**Considered:** keeping `ui-slots`' eager model and requiring frames to use
unique, frame-scoped slot names — rejected because it forces every
chrome/pane plugin to be written against one specific frame's naming rather
than a portable convention.

**Consequences:** declaration lifecycle for a chain slot is now tied to
election, not registration — switching the elected frame tears down and
rebuilds its subtree of declared children, which the frame-arrangement and
slot-conflict-negotiation tickets' implementations must account for.
