import { Schema as S } from "effect";

/** Primitive checks reused by session.ts and workspace.ts, whose persisted
 *  and live schemas both validate the same handful of scalar shapes. One
 *  definition keeps the two from drifting apart on what counts as valid. */
export const NonEmptyString = S.String.pipe(S.check(S.isMinLength(1)));
export const PositiveInt = S.Int.pipe(S.check(S.isGreaterThan(0)));
