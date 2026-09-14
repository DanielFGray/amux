/**
 * Projection substrate spike (ts-27d143 / live-image plan move 3).
 *
 * Settled: a surface is a structured value with a URI; text is one projection
 * (decision 2). Only natively-text surfaces accept edits back (decision 3).
 *
 * The addendum's requirement: toText alone is not enough. Shared ops need
 * addressable objects and stable selections. Core routes without interpreting
 * plugin payload schemas (ARCHITECTURE.md policy-versus-algebra).
 *
 * Selection identity lives in a plugin-owned pin. TextPoint/TextRange are
 * ephemeral coordinates into a regenerated projection — never stored as marks,
 * registers, or jump targets.
 */
import type { Option } from "effect";
import { Schema as S } from "effect";

/** Surface identity. Core stores and routes; plugins own the scheme. */
export type SurfaceUri = string;

/** Ephemeral display cursor into a projection. Cite: editor Cursor, but not a mark. */
export const TextPoint = S.Struct({ row: S.Int, col: S.Int });
export type TextPoint = S.Schema.Type<typeof TextPoint>;

export const TextRange = S.Struct({
  anchor: TextPoint,
  head: TextPoint,
});
export type TextRange = S.Schema.Type<typeof TextRange>;

/**
 * Regenerated on demand. Width is part of the view: a resize discards the
 * prior projection (transcript-rendering.md). Never treat lines as identity.
 */
export type TextProjection = {
  readonly lines: readonly string[];
  readonly width: number;
};

/**
 * Stable selection: surface URI + opaque pin. Core never inspects `pin`.
 * Plugins encode payload-native identity (block key, diagnostic URI, …).
 */
export type Selection<Pin = unknown> = {
  readonly surface: SurfaceUri;
  readonly pin: Pin;
};

/**
 * One addressable surface. Plugins supply payload schemas and the pin
 * codec; core only requires project / pin / locate.
 */
export interface ProjectionSurface<Payload, Pin> {
  readonly uri: SurfaceUri;
  snapshot(): Payload;
  project(width: number): TextProjection;
  /** Map a display range into a stable pin against the current projection. */
  pin(range: TextRange, width: number): Pin;
  /**
   * Re-resolve a pin after the payload changes. `None` means the referent
   * is gone (truncated, deleted block) — a dangling mark, honestly.
   */
  locate(pin: Pin, width: number): Option.Option<TextRange>;
}

/** Plain text under a range — yank/search fodder. Inclusive endpoints. */
export const textInRange = (projection: TextProjection, range: TextRange): string => {
  const start =
    range.anchor.row < range.head.row ||
    (range.anchor.row === range.head.row && range.anchor.col <= range.head.col)
      ? range.anchor
      : range.head;
  const end = start === range.anchor ? range.head : range.anchor;
  if (start.row === end.row) {
    const line = projection.lines[start.row] ?? "";
    return line.slice(start.col, end.col + 1);
  }
  const parts: string[] = [];
  const first = projection.lines[start.row] ?? "";
  parts.push(first.slice(start.col));
  for (let row = start.row + 1; row < end.row; row++) {
    parts.push(projection.lines[row] ?? "");
  }
  const last = projection.lines[end.row] ?? "";
  parts.push(last.slice(0, end.col + 1));
  return parts.join("\n");
};
