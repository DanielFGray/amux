import type { KeyEvent } from "@opentui/core";

/**
 * A key context: something that can claim keys while a reactive predicate
 * holds. Peer to `CommandSpec` (bindings.ts) — both arrive through a
 * `contributions.table`, owner-scoped and retiring with the instance that
 * registered them (contributions.ts).
 *
 * This is the registry. `apply` (bindings.ts) resolves a context's
 * `CommandSpec`s into a keymap layer; `activeHandler` below resolves its
 * catch-all for what the keymap left unclaimed. `onUnhandled` (app.tsx) still
 * hand-rolls copy mode's tier — that migration is a later ticket in
 * ep-227150.
 */
export interface ContextSpec {
  /** Dotted name, e.g. "copy-mode" or "app.prefix". Unique per owner, the
   *  same way a command name is. */
  id: string;
  /** Reactive: read the way `OverlayOccupant.visible` is (ui/slots.ts:82).
   *  Several contexts may be active at once, as an ordered set — this is not
   *  an election. */
  active: () => boolean;
  /** Higher wins. Compared the way `@opentui/keymap` orders layers
   *  (`compareLayers`, priority descending): a same-priority tie falls to
   *  registration order, later wins. See CONTEXT_PRIORITY for the bands core
   *  claims. */
  priority: number;
  /** Whether the keys this context binds appear in the settings keybind
   *  editor for remapping. False for a context whose keys are fixed by its
   *  owner rather than user configuration. */
  rebindable: boolean;
  /**
   * A catch-all for a context whose keys cannot be discrete named bindings —
   * a modal panel deciding what "j" or a typed character means from its own
   * live focus state, the way `OverlayOccupant.keys` (ui/slots.ts) used to
   * before it moved here. Most contexts have none: their keys are `CommandSpec`s
   * (`contextCommand`, bindings.ts) compiled into the context's own keymap
   * layer, and the keymap has already tried those before a key ever reaches
   * `activeHandler`.
   */
  handle?: (event: KeyEvent) => boolean;
}

/**
 * The active context an unclaimed key belongs to: highest `priority` wins, a
 * tie going to whichever registered later — the ordering `@opentui/keymap`
 * layers use (bindings.ts's `apply`), kept consistent so one precedence rule
 * governs both a context's bindings and its catch-all. Only a context
 * declaring `handle` is a candidate; a context with only bindings has
 * nothing left to claim once the keymap already tried them.
 */
export function activeHandler(contexts: readonly ContextSpec[]): ContextSpec | null {
  let winner: ContextSpec | null = null;
  for (const context of contexts) {
    if (!context.handle || !context.active()) continue;
    if (!winner || context.priority >= winner.priority) winner = context;
  }
  return winner;
}

/**
 * Named tiers for `ContextSpec.priority`, describing the precedence
 * onUnhandled already has by construction (app.tsx:1930-1948): the top
 * overlay owns unhandled keys first, then app-wide modes (copy mode today),
 * then the focused pane, with the global layer last. Each band leaves 99
 * numbers above it for a plugin to slot a context between two tiers without
 * core reserving room in advance.
 */
export const CONTEXT_PRIORITY = {
  GLOBAL: 0,
  PANE: 100,
  APP_MODE: 200,
  OVERLAY: 300,
} as const;

/** Two or more contexts claiming the same `priority`. Registration order
 *  (the order they arrived in the input) breaks the tie meanwhile. */
export interface ContextPriorityConflict {
  priority: number;
  /** Context ids claiming this priority, in registration order. */
  contexts: string[];
}

/**
 * A same-priority collision is reported, not thrown — deliberately unlike
 * slots.ts's `SlotConflictError`. Once a user's config can cause the
 * collision (a plugin's declared priority meeting another plugin's, or a
 * config override), refusing to start is no way to tell them; that is the
 * same reasoning that made `findConflicts` (bindings.ts) stop throwing.
 */
export function findContextPriorityConflicts(
  contexts: readonly ContextSpec[],
): ContextPriorityConflict[] {
  const byPriority = new Map<number, string[]>();
  for (const context of contexts) {
    const existing = byPriority.get(context.priority);
    if (existing) existing.push(context.id);
    else byPriority.set(context.priority, [context.id]);
  }
  return [...byPriority]
    .filter(([, ids]) => ids.length > 1)
    .map(([priority, ids]) => ({ priority, contexts: ids }));
}
