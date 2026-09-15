import type { KeyEvent } from "@opentui/core";
import type { KeyData } from "./key-invocation.ts";

/** The part of a keymap's pre-dispatch input available to a context. Kept
 * narrow so a context can accumulate arguments without taking ownership of
 * the keymap or inventing a second dispatch path. */
export interface ContextKeyInput {
  readonly event: KeyEvent;
  readonly setData: <K extends keyof KeyData>(
    name: K,
    value: Exclude<KeyData[K], undefined>,
  ) => void;
  readonly consume: (options?: { preventDefault?: boolean; stopPropagation?: boolean }) => void;
  /** Whether `name` is bound in the active keymap right now. */
  readonly bound: (name: string) => boolean;
  /** Refresh showcmd / pending subscribers after this context changed pending state. */
  readonly notifyPending: () => void;
}

/**
 * A key context: something that can claim keys while a reactive predicate
 * holds. Peer to `CommandSpec` (bindings.ts) — both arrive through a
 * `contributions.table`, owner-scoped and retiring with the instance that
 * registered them (contributions.ts).
 *
 * This is the registry. `apply` (bindings.ts) resolves a context's
 * `CommandSpec`s into a keymap layer; `resolveUnhandled` below resolves its
 * catch-all for what the keymap left unclaimed.
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
   * Re-expose every global binding beginning with `<prefix>` without that
   * first token while this context is active. The bindings compiler derives
   * the aliases from the effective user keymap, so contexts do not copy the
   * command table or drift from later rebindings.
   */
  globalLeaderAliases?: {
    /** Runs after a projected global command, including when it fails. */
    afterCommand?: () => void;
  };

  /** Observe a key before this context's bindings resolve. A context uses
   * this for grammar state such as a Vim count, then publishes it through
   * `setData` for the binding's `KeyInvocation`. */
  beforeDispatch?: (input: ContextKeyInput) => void;
  /**
   * A catch-all for a context whose keys cannot be discrete named bindings —
   * a modal panel deciding what "j" or a typed character means from its own
   * live focus state, the way `OverlayOccupant.keys` (ui/slots.ts) used to
   * before it moved here. Most contexts have none: their keys are `CommandSpec`s
   * (`contextCommand`, bindings.ts) compiled into the context's own keymap
   * layer, and the keymap has already tried those before a key ever reaches
   * `resolveUnhandled`.
   */
  handle?: (event: KeyEvent) => boolean;
  /**
   * Open the which-key panel the moment this context becomes active, behind
   * the same `appearance.whichKeyDelay` a half-typed sequence waits out.
   * Copy mode wants this — v/y/n are undiscoverable otherwise — while most
   * contexts don't: an editor's normal mode should not flash a panel on
   * every mode change. False (the default) leaves the panel exactly as
   * leader-triggered as it always was.
   */
  showOnEntry?: boolean;
  /**
   * After a handled key, hide an entry-triggered hint panel and begin its
   * normal delay again. Persistent command modes use this so the panel helps
   * after a pause without covering the result of every command.
   */
  rearmHintsOnKey?: boolean;
  /**
   * When false, an active OVERLAY-band context does not block the pane via
   * {@link overlayBlocksPane}. Error/inspect snacks only claim Escape; every
   * other key must still reach the PTY. Default (omit / true): declining a key
   * means "leave it for a focused OpenTUI input", not the pane.
   */
  blocksPane?: boolean;
  /**
   * The which-key panel's entry for this context, while it has no `handle`
   * substitute: a context with `handle` (above) reads its own live state to
   * decide what a key does, so there is no `CommandSpec` `nextKeys` could
   * read a binding back from — the same gap `handle` fills for dispatch,
   * filled here for display. Shown only at the top of the tree (nothing
   * typed yet): these are always single, unprefixed keys, so once a
   * sequence is under way a typed prefix has already said more than this
   * list can. Grouped under the context's own id — the label the which-key
   * panel renders alongside every `CommandSpec`-derived group.
   */
  hints?: readonly { keys: string[]; desc: string }[];
  /**
   * Continuations while this context owns a pending prefix that is not on
   * the mux keymap (editor pendingMap, …). When non-null, which-key shows
   * these instead of keymap graph continuations.
   */
  pendingContinuations?: () => {
    readonly pending: readonly string[];
    /** Which-key group label for {@link entries}. */
    readonly group: string;
    readonly entries: readonly { keys: string[]; desc: string }[];
  } | null;
}

/**
 * Offer an unclaimed key to every active context that declares `handle`,
 * highest `priority` first (a tie going to whichever registered later — the
 * ordering `@opentui/keymap` layers use, bindings.ts's `apply`, kept
 * consistent so one precedence rule governs both a context's bindings and
 * its catch-all). Stops at the first `handle` that returns true.
 *
 * A `false` does not fall all the way through to the caller's own fallback —
 * it falls to the NEXT active context, same as an unclaimed key falls from
 * one keymap layer to the layer below it. This is what lets a
 * higher-priority context claim only one key and leave everything else to a
 * context beneath it: copy mode's escape-layering registers "a selection is
 * active" one band above copy mode itself, claiming only Escape, so every
 * other copy-mode key still reaches copy mode's own handler undisturbed.
 */
export function resolveUnhandled(contexts: readonly ContextSpec[], event: KeyEvent): boolean {
  const candidates = contexts
    .map((context, order) => ({ context, order }))
    .filter(({ context }) => context.handle && context.active())
    .sort((a, b) => b.context.priority - a.context.priority || b.order - a.order);
  for (const { context } of candidates) {
    if (context.handle!(event)) return true;
  }
  return false;
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

/**
 * An overlay-band context that declines a key (`handle` → false) is yielding
 * to a focused OpenTUI input — palette filter, prompt field, settings edit —
 * not to the pane. `onUnhandled` must not fall through to a PTY in that case:
 * the pane would claim the key and `preventDefault` it, starving the input.
 *
 * Opt out with `blocksPane: false` for chrome that only claims Escape (error
 * snack, inspect) — otherwise a sticky snack after plugin load eats ctrl+c /
 * ctrl+d in terminals.
 */
export function overlayBlocksPane(contexts: readonly ContextSpec[]): boolean {
  return contexts.some(
    (context) =>
      context.active() &&
      context.priority >= CONTEXT_PRIORITY.OVERLAY &&
      context.blocksPane !== false,
  );
}

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
