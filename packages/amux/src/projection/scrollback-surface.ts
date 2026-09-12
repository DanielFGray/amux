/**
 * Spike fixture: PTY scrollback as an append-mostly grid.
 *
 * Real capture.ts uses ghostty's uniform scrollback (row 0 = oldest). This
 * fixture models the two mutations that matter for open question 4:
 * append at the bottom (row indices of older content stay), and drop from
 * the top when the ring fills (every surviving row renumbers).
 *
 * There is no payload-native row identity in a VT grid — the grid *is* the
 * payload. Stability is generation-scoped: a pin records the truncate
 * generation plus (y, x). After a top-drop, locate returns None rather than
 * silently pointing at different text.
 */
import { Option } from "effect";
import type { ProjectionSurface, SurfaceUri, TextProjection, TextRange } from "./contract.ts";

export type ScrollbackPin = {
  readonly gen: number;
  readonly y: number;
  readonly x: number;
};

export class ScrollbackSurface implements ProjectionSurface<readonly string[], ScrollbackPin> {
  readonly uri: SurfaceUri;
  #rows: string[];
  #gen = 0;
  #cap: number;

  constructor(uri: string, rows: readonly string[] = [], cap = 10_000) {
    this.uri = uri;
    this.#rows = [...rows];
    this.#cap = cap;
  }

  snapshot(): readonly string[] {
    return this.#rows;
  }

  append(row: string): void {
    this.#rows = [...this.#rows, row];
    while (this.#rows.length > this.#cap) {
      this.#rows = this.#rows.slice(1);
      this.#gen += 1;
    }
  }

  /** Force a top-drop of `n` rows (models scrollback ring eviction). */
  dropOldest(n: number): void {
    if (n <= 0) return;
    const drop = Math.min(n, this.#rows.length);
    this.#rows = this.#rows.slice(drop);
    this.#gen += drop;
  }

  generation(): number {
    return this.#gen;
  }

  project(_width: number): TextProjection {
    // Width ignored: scrollback rows are already cell-laid-out. Real PTY
    // painting still needs cell↔char maps (copy.ts RowMap); yank works on text.
    return { lines: this.#rows, width: _width };
  }

  pin(range: TextRange, _width: number): ScrollbackPin {
    // Point pins: store the head. Range yank uses textInRange on a live project.
    return { gen: this.#gen, y: range.head.row, x: range.head.col };
  }

  locate(pin: ScrollbackPin, _width: number): Option.Option<TextRange> {
    if (pin.gen !== this.#gen) return Option.none();
    if (pin.y < 0 || pin.y >= this.#rows.length) return Option.none();
    const line = this.#rows[pin.y] ?? "";
    if (pin.x < 0 || pin.x > line.length) return Option.none();
    const point = { row: pin.y, col: Math.min(pin.x, Math.max(0, line.length - 1)) };
    return Option.some({ anchor: point, head: point });
  }
}
