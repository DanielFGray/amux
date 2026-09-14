/**
 * Spike fixture: agent transcript as an append-only list of structured turns.
 *
 * Mirrors harness TranscriptBlock identity (chatBlockKey) without importing
 * the harness into core — payload schema stays plugin-owned. Projection is
 * one line per block (width wrapping deferred; reflow is a separate kill
 * case exercised by changing width with wrapped lines in the test).
 *
 * Pin = block key + character offset into that block's projected line.
 * Survives appending new blocks and survives streaming growth of *other*
 * blocks. Dies only when the keyed block itself disappears.
 */
import { Match, Option } from "effect";
import type { ProjectionSurface, SurfaceUri, TextProjection, TextRange } from "./contract.ts";

export type TranscriptBlock =
  | { readonly kind: "user"; readonly turn: string; readonly text: string }
  | { readonly kind: "assistant"; readonly turn: string; readonly text: string }
  | { readonly kind: "tool"; readonly turn: string; readonly call: string; readonly name: string };

export type TranscriptPin = {
  readonly blockKey: string;
  readonly offset: number;
};

export const blockKey = (block: TranscriptBlock): string =>
  Match.value(block).pipe(
    Match.when({ kind: "user" }, (b) => `user:${b.turn}`),
    Match.when({ kind: "assistant" }, (b) => `assistant:${b.turn}`),
    Match.when({ kind: "tool" }, (b) => `tool:${b.turn}:${b.call}`),
    Match.exhaustive,
  );

const projectLine = (block: TranscriptBlock): string =>
  Match.value(block).pipe(
    Match.when({ kind: "user" }, (b) => `user> ${b.text}`),
    Match.when({ kind: "assistant" }, (b) => `assistant> ${b.text}`),
    Match.when({ kind: "tool" }, (b) => `tool> ${b.name}`),
    Match.exhaustive,
  );

export class TranscriptSurface implements ProjectionSurface<
  readonly TranscriptBlock[],
  TranscriptPin
> {
  readonly uri: SurfaceUri;
  #blocks: TranscriptBlock[];

  constructor(uri: string, blocks: readonly TranscriptBlock[] = []) {
    this.uri = uri;
    this.#blocks = [...blocks];
  }

  snapshot(): readonly TranscriptBlock[] {
    return this.#blocks;
  }

  append(block: TranscriptBlock): void {
    this.#blocks = [...this.#blocks, block];
  }

  /** Grow an existing assistant/user block in place (streaming). */
  stream(turn: string, kind: "user" | "assistant", more: string): void {
    this.#blocks = this.#blocks.map((block) => {
      if (block.kind !== kind || block.turn !== turn) return block;
      return { ...block, text: block.text + more };
    });
  }

  project(width: number): TextProjection {
    // Naive wrap: fixed-width chunking so reflow renumbers display rows.
    const lines = this.#blocks.flatMap((block) => wrap(projectLine(block), width));
    return { lines, width };
  }

  pin(range: TextRange, width: number): TranscriptPin {
    return Option.getOrElse(pointToBlock(this.#blocks, range.head, width), () => ({
      blockKey: "",
      offset: 0,
    }));
  }

  locate(pin: TranscriptPin, width: number): Option.Option<TextRange> {
    const point = blockToPoint(this.#blocks, pin, width);
    return Option.map(point, (p) => ({ anchor: p, head: p }));
  }
}

const wrap = (text: string, width: number): string[] => {
  if (width < 1) throw new Error("projection width must be positive");
  if (text.length === 0) return [""];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
};

/** Display point → owning block key + offset within that block's full line. */
const pointToBlock = (
  blocks: readonly TranscriptBlock[],
  point: { row: number; col: number },
  width: number,
): Option.Option<TranscriptPin> => {
  let row = 0;
  for (const block of blocks) {
    const full = projectLine(block);
    const wrapped = wrap(full, width);
    for (let i = 0; i < wrapped.length; i++) {
      if (row === point.row) {
        const offset = i * width + Math.min(point.col, wrapped[i]!.length);
        return Option.some({ blockKey: blockKey(block), offset });
      }
      row += 1;
    }
  }
  return Option.none();
};

const blockToPoint = (
  blocks: readonly TranscriptBlock[],
  pin: TranscriptPin,
  width: number,
): Option.Option<{ row: number; col: number }> => {
  let row = 0;
  for (const block of blocks) {
    const full = projectLine(block);
    const wrapped = wrap(full, width);
    if (blockKey(block) === pin.blockKey) {
      if (pin.offset < 0 || pin.offset > full.length) return Option.none();
      const wrapRow = Math.min(wrapped.length - 1, Math.floor(pin.offset / width));
      const col = pin.offset - wrapRow * width;
      return Option.some({ row: row + wrapRow, col });
    }
    row += wrapped.length;
  }
  return Option.none();
};
