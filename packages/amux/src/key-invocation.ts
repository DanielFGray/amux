import { Context } from "effect";
import type { KeyEvent } from "@opentui/core";

/**
 * What the keymap captured for one command dispatch — the library's own
 * `CommandContext` (types.d.ts), which `apply()` (bindings.ts) used to
 * throw away entirely: every command registered as `run: () => ...`, a
 * nullary arrow discarding `event`/`data`/`input`/`payload` alike. Wiring
 * this up is deleting that discard, not adding a new channel.
 *
 * Provided as a requirement rather than threaded through every
 * `CommandSpec.run` by hand: a command that needs it declares
 * `Effect<A, CommandError, KeyInvocation>` and the type says so; one that
 * doesn't stays `Effect<A, CommandError>` (`never` is assignable wherever
 * `KeyInvocation` is required, so every existing command is unchanged).
 */
export interface KeyInvocationValue {
  readonly event: KeyEvent;
  /**
   * Whatever the dispatching context captured before this command ran — a
   * count, a register letter, a find-motion's target char, a text object,
   * or nothing. One bag rather than one field per shape: a context decides
   * what it captures, and this module cannot enumerate every context's
   * vocabulary in advance.
   */
  readonly data: Readonly<Record<string, unknown>>;
  readonly input: string;
  readonly payload: unknown;
}

export class KeyInvocation extends Context.Service<KeyInvocation, KeyInvocationValue>()(
  "amux/KeyInvocation",
) {}

/**
 * A count accumulator implementing the claim rule which-key, helix and
 * kakoune all share: a digit is a count only where the calling context has
 * not bound it to something else itself. That rule is what lets "0" work as
 * both a motion (bound, count empty) and a count digit (once a count is
 * already under way, "0" extends it instead of firing whatever it's bound
 * to) — the same behavior the editor already has in vim-core.ts
 * (`isCountDigit`/`parsedCount`), generalized here rather than copied: that
 * version is wired to vim's own `pending`/`pendingG` state, so this one
 * takes "is this key claimed here" as a parameter instead, letting any
 * context supply its own answer.
 *
 * A context wanting counts calls `offer` on every key ahead of its own
 * dispatch; `true` means the key was consumed into the count and the
 * context should stop there, `false` means dispatch normally. `reset`
 * belongs after the count is actually spent — the motion or operator that
 * consumed it, not every keystroke.
 */
export interface CountAccumulator {
  readonly digits: () => string;
  /** The accumulated count, defaulting to 1 — the value a command wants,
   *  never the empty string a caller would have to special-case. */
  readonly count: () => number;
  readonly offer: (key: KeyEvent, isBoundHere: (name: string) => boolean) => boolean;
  readonly reset: () => void;
}

export function createCountAccumulator(): CountAccumulator {
  let digits = "";
  return {
    digits: () => digits,
    count: () => {
      if (digits === "") return 1;
      const value = Number.parseInt(digits, 10);
      return Number.isFinite(value) && value > 0 ? value : 1;
    },
    offer(key, isBoundHere) {
      if (key.ctrl || key.meta || key.option) return false;
      if (key.name.length !== 1 || !/[0-9]/.test(key.name)) return false;
      // A leading zero is a motion, not a count start — vim-core.ts's own
      // rule (isCountDigit), generalized: it only wins over the count if
      // this context actually bound it to something.
      if (key.name === "0" && digits === "" && isBoundHere("0")) return false;
      digits += key.name;
      return true;
    },
    reset() {
      digits = "";
    },
  };
}
