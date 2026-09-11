/**
 * Mapping-chord matcher: pending strokes, exact-vs-prefix disambiguation,
 * `'timeoutlen'`, and sticky **minimodes** (hydra-style: a registered prefix
 * stays armed after each match until Escape). Shared algebra for mux
 * `<prefix>` maps, plugin maps (editor `<leader>` / `grr` / …), and modes
 * like window (`<prefix>ctrl+w`) — one trie, one wait state.
 *
 * Not vim operator grammar — that stays in vim-core.
 *
 * `push` stays sync (key intercepts are). Timeouts are Effect fibers:
 * `Effect.sleep(Duration)` on the Clock, interrupted to cancel — same shape as
 * `scheduleHintVisibility` / session-facts timers.
 * Cite: neovim/src/nvim/input.c `handle_mapping` + `KEYLEN_PART_MAP`;
 * hydra.nvim / which-key sticky for minimode.
 */

import { Duration, Effect, Fiber, Option } from "effect";

export type ChordStroke = string;

export interface ChordBinding {
  readonly id: string;
  readonly strokes: readonly ChordStroke[];
  readonly run: () => void;
  /** When omitted, the binding is always eligible. */
  readonly active?: () => boolean;
  /** which-key / showcmd label. Omitted → id is not shown as a hint. */
  readonly desc?: string;
  /** which-key group heading. Default `"chords"`. */
  readonly group?: string;
  /** Hidden from which-key (still dispatchable). */
  readonly hidden?: boolean;
  /** Hint sort priority — higher first. Context-scoped commands use context priority. */
  readonly priority?: number;
}

/**
 * A sticky chord prefix shared by mux and editor (window mode, sticky `g`, …).
 * Entered automatically when pending lands exactly on {@link ChordMode.strokes};
 * after a longer match under that prefix, pending restores to the mode root
 * until Escape / {@link ChordMatcher.clear}.
 */
export interface ChordMode {
  readonly id: string;
  readonly strokes: readonly ChordStroke[];
  /** Optional which-key / chrome label while idle in the mode. */
  readonly desc?: string;
}

export type ChordPushResult =
  | { readonly _tag: "matched"; readonly id: string }
  | { readonly _tag: "pending"; readonly strokes: readonly ChordStroke[] }
  | { readonly _tag: "miss" };

/**
 * Fork an Effect onto a fiber. Live default is {@link Effect.runFork}; tests
 * pass {@link Effect.runForkWith} over a TestClock context so
 * `TestClock.adjust` drives `'timeoutlen'`.
 */
export type ChordFork = <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;

export interface ChordMatcherOpts {
  /** Ambiguous exact-vs-prefix wait. Default {@link DEFAULT_CHORD_TIMEOUTLEN}. */
  readonly timeoutlen?: Duration.Input;
  readonly runFork?: ChordFork;
  /**
   * Ambiguous pending with no exact binding timed out: re-emit the abandoned
   * strokes as non-mapped input (neovim: typed keys after map timeout).
   * Not called when pending is an active minimode root (mode stays armed).
   */
  readonly onAmbiguousTimeout?: (strokes: readonly ChordStroke[]) => void;
}

export interface ChordMatcher {
  register(binding: ChordBinding): () => void;
  /** Sticky prefix mode — mux window, editor `g`, … Same matcher for both. */
  registerMode(mode: ChordMode): () => void;
  push(stroke: ChordStroke): ChordPushResult;
  clear(): void;
  pending(): readonly ChordStroke[];
  activeMode(): ChordMode | null;
  /** Active bindings (for which-key / tests). */
  activeBindings(): readonly ChordBinding[];
  subscribe(listener: (pending: readonly ChordStroke[]) => void): () => void;
  setTimeoutlen(input: Duration.Input): void;
  timeoutlen(): Duration.Duration;
  /**
   * Re-arm `'timeoutlen'` for the current pending sequence (no-op if idle).
   * which-key calls this when the panel opens so the user gets a full wait
   * from the moment the hints appear, not from the first stroke.
   */
  rearmTimeout(): void;
  setAmbiguousTimeout(handler: ((strokes: readonly ChordStroke[]) => void) | null): void;
  dispose(): void;
}

const strokesEqual = (a: readonly ChordStroke[], b: readonly ChordStroke[]): boolean =>
  a.length === b.length && a.every((stroke, i) => stroke === b[i]);

const isStrictPrefix = (
  prefix: readonly ChordStroke[],
  full: readonly ChordStroke[],
): boolean =>
  prefix.length < full.length && prefix.every((stroke, i) => stroke === full[i]);

const startsWith = (
  prefix: readonly ChordStroke[],
  full: readonly ChordStroke[],
): boolean =>
  prefix.length <= full.length && prefix.every((stroke, i) => stroke === full[i]);

/** Neovim default `'timeoutlen'` — room for which-key delay beneath the wait. */
export const DEFAULT_CHORD_TIMEOUTLEN = Duration.millis(1000);

/** Millisecond mirror for Keys / OpenTUI bridges that still speak numbers. */
export const DEFAULT_CHORD_TIMEOUTLEN_MS = 1000;

export function createChordMatcher(opts: ChordMatcherOpts = {}): ChordMatcher {
  const runFork: ChordFork = opts.runFork ?? Effect.runFork;
  let timeoutlen = Option.getOrElse(Duration.fromInput(opts.timeoutlen ?? DEFAULT_CHORD_TIMEOUTLEN), () =>
    DEFAULT_CHORD_TIMEOUTLEN,
  );
  let onAmbiguousTimeout = opts.onAmbiguousTimeout ?? null;
  const bindings = new Map<string, ChordBinding>();
  const modes = new Map<string, ChordMode>();
  let pending: ChordStroke[] = [];
  let activeMode: ChordMode | null = null;
  let timeoutFiber: Fiber.Fiber<void> | null = null;
  const listeners = new Set<(pending: readonly ChordStroke[]) => void>();

  const notify = () => {
    const snapshot = pending.slice();
    for (const listener of listeners) listener(snapshot);
  };

  const stopTimer = () => {
    if (timeoutFiber === null) return;
    Effect.runFork(Fiber.interrupt(timeoutFiber));
    timeoutFiber = null;
  };

  const activeBindings = (): ChordBinding[] =>
    Array.from(bindings.values()).filter((binding) => binding.active?.() ?? true);

  const exactAt = (strokes: readonly ChordStroke[]): ChordBinding | undefined =>
    activeBindings().find((binding) => strokesEqual(binding.strokes, strokes));

  const hasLongerPrefix = (strokes: readonly ChordStroke[]): boolean =>
    activeBindings().some((binding) => isStrictPrefix(strokes, binding.strokes));

  const modeAt = (strokes: readonly ChordStroke[]): ChordMode | null => {
    for (const mode of modes.values()) {
      if (strokesEqual(strokes, mode.strokes)) return mode;
    }
    return null;
  };

  const exitMode = () => {
    activeMode = null;
  };

  const armTimeout = (strokes: readonly ChordStroke[]) => {
    stopTimer();
    if (Duration.toMillis(timeoutlen) <= 0) return;
    const frozen = strokes.slice();
    timeoutFiber = runFork(
      Effect.sleep(timeoutlen).pipe(
        Effect.andThen(
          Effect.sync(() => {
            timeoutFiber = null;
            if (!strokesEqual(pending, frozen)) return;
            const exact = exactAt(frozen);
            if (exact) {
              pending = [];
              notify();
              exact.run();
              // Sticky restore if this exact was under a mode (rare: mode root
              // itself bound) — fireExact path handles the common case.
              const mode = activeMode;
              if (mode !== null && isStrictPrefix(mode.strokes, exact.strokes)) {
                pending = mode.strokes.slice();
                notify();
                armTimeout(pending);
              } else {
                exitMode();
              }
              return;
            }
            // Minimode root: stay armed; do not map-fail to the PTY.
            if (activeMode !== null && strokesEqual(frozen, activeMode.strokes)) {
              armTimeout(frozen);
              return;
            }
            pending = [];
            exitMode();
            notify();
            onAmbiguousTimeout?.(frozen);
          }),
        ),
      ),
    );
  };

  const becomePending = (strokes: ChordStroke[]): ChordPushResult => {
    pending = strokes;
    const mode = modeAt(strokes);
    if (mode !== null) activeMode = mode;
    notify();
    armTimeout(strokes);
    return { _tag: "pending", strokes: pending.slice() };
  };

  const fireExact = (binding: ChordBinding): ChordPushResult => {
    stopTimer();
    const mode = activeMode;
    const sticky = mode !== null && isStrictPrefix(mode.strokes, binding.strokes);
    pending = [];
    notify();
    binding.run();
    if (sticky && mode !== null) {
      pending = mode.strokes.slice();
      activeMode = mode;
      notify();
      armTimeout(pending);
    } else {
      exitMode();
    }
    return { _tag: "matched", id: binding.id };
  };

  return {
    register(binding) {
      if (binding.strokes.length === 0) {
        throw new Error(`chord ${binding.id}: empty stroke sequence`);
      }
      bindings.set(binding.id, binding);
      return () => {
        bindings.delete(binding.id);
      };
    },

    registerMode(mode) {
      if (mode.strokes.length === 0) {
        throw new Error(`chord mode ${mode.id}: empty stroke sequence`);
      }
      modes.set(mode.id, mode);
      return () => {
        modes.delete(mode.id);
        if (activeMode?.id === mode.id) {
          exitMode();
          stopTimer();
          pending = [];
          notify();
        }
      };
    },

    push(stroke) {
      if (stroke.length === 0) return { _tag: "miss" };
      // Escape always exits (chord feed usually clears first; this is the
      // shared exit for direct push / editor hosts that call matcher alone).
      if (stroke.toLowerCase() === "escape") {
        if (pending.length === 0 && activeMode === null) return { _tag: "miss" };
        this.clear();
        return { _tag: "miss" };
      }
      stopTimer();
      const candidate = [...pending, stroke];
      const longer = hasLongerPrefix(candidate);
      const exact = exactAt(candidate);

      if (longer) {
        return becomePending(candidate);
      }
      if (exact) {
        return fireExact(exact);
      }

      // Unbound key inside a minimode: stay in the mode (hydra), do not
      // map-fail into a bare key that would reach the PTY / editor.
      if (
        activeMode !== null &&
        pending.length > 0 &&
        startsWith(activeMode.strokes, pending)
      ) {
        pending = activeMode.strokes.slice();
        notify();
        armTimeout(pending);
        return { _tag: "pending", strokes: pending.slice() };
      }

      // Continuation failed: abandon the partial map, then try this stroke alone
      // as a fresh sequence (neovim map-fail behaviour).
      if (pending.length > 0) {
        pending = [];
        exitMode();
        notify();
        return this.push(stroke);
      }
      return { _tag: "miss" };
    },

    clear() {
      stopTimer();
      const had = pending.length > 0 || activeMode !== null;
      pending = [];
      exitMode();
      if (had) notify();
    },

    pending: () => pending.slice(),

    activeMode: () => activeMode,

    activeBindings: () => activeBindings(),

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setTimeoutlen(input) {
      timeoutlen = Option.getOrElse(Duration.fromInput(input), () => timeoutlen);
    },

    timeoutlen: () => timeoutlen,

    rearmTimeout() {
      if (pending.length === 0) return;
      armTimeout(pending.slice());
    },

    setAmbiguousTimeout(handler) {
      onAmbiguousTimeout = handler;
    },

    dispose() {
      stopTimer();
      bindings.clear();
      modes.clear();
      pending = [];
      exitMode();
      listeners.clear();
      onAmbiguousTimeout = null;
    },
  };
}
