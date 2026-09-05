# Tiling algorithm is a chain-kind slot occupant, not a separate mechanism

The frame-arrangement design (ADR 0001) modeled frame election as a `chain`-kind
slot: candidates register a selector over live context, the first match wins,
re-evaluated every render. The tiling-algorithm design (ep-e09db9, ts-7ac979)
needed the same shape for a different reason — a responsive algorithm (collapse
to one pane below some terminal width, the herdr scenario) must react to live
size the same way a responsive frame reacts to it.

Once the tiling algorithm's output was decided to be opaque and plugin-owned
(so a niri-style scrolling column layout, which has no weight-tree at all,
doesn't have to be lossily forced into one), and its re-evaluation was decided
to be chain-style (live size in, re-run every render, not just on discrete
operations), the mechanism was already identical to slot election in every
load-bearing respect. The only difference left was administrative: CONTEXT.md
had tiling algorithm carved out as "not a slot occupant," a boundary drawn
before either design's shape was known.

Decided: the frame declares a `pane-host` slot (chain-kind); tiling-algorithm
plugins are chain candidates for it, competing on the same live-context
selectors (size, workspace, session count) as frame candidates compete for the
root. A frame's job narrows to declaring where the pane-host slot lives, not
which algorithm fills it.

**Considered:** keep tiling algorithm as a categorically separate,
config-selected mechanism (its original scoping) — rejected once the shape
converged with chain-kind election anyway; keeping two named mechanisms that
behave identically would cost future readers more than the one narrow argument
for separateness (that an algorithm's persisted state is tied directly to
session.json) actually buys, especially once persistence was decided to be
plugin-owned and opaque regardless of which mechanism selects the plugin.

**Consequences:**
- One election mechanism (chain-kind slots) now governs frame, chrome,
  pinned panes, and tiling algorithm — a plugin author learns it once.
- A tiling algorithm's persisted state is a plugin-owned opaque blob,
  independent of the slot mechanism itself (slots are never persisted;
  election is recomputed every session, same as frame election).
- Election handoff (switching the elected algorithm, whether by a live resize
  or a config change) always initializes the newly-elected algorithm from the
  flat list of currently-open real panes — never from the outgoing algorithm's
  opaque state, which the new algorithm has no way to interpret.
- Tiling-algorithm plugins may define their own operation vocabulary (e.g.
  niri's "insert into scroll" instead of a binary "split"); core requires only
  a small universal subset (close-pane, focus-move) every algorithm must
  still support.
