/**
 * Session and pane id Schemas plus the constructors plugins and core share.
 *
 * Session ids: constructor mints `agent-<uuid>`; Schema accepts any non-empty
 * string (resume and fixtures use other forms). Proposed pane ids are always
 * new hierarchical `{space}:p{number}` — replace carries no pane id.
 */
import { Effect, Schema as S, SchemaGetter, SchemaIssue } from "effect";
import { randomUUID } from "node:crypto";
import { NonEmptyString, PositiveInt } from "./schema-primitives.ts";

/** Any non-empty string — resume ids and fixtures are not `agent-<uuid>`. */
export const SessionIdSchema = NonEmptyString;
export type SessionId = typeof SessionIdSchema.Type;

const NEW_PANE_ID_RE = /^(.+):p([1-9]\d*)$/;

/** Hierarchical pane id a reducer proposes for a newly minted leaf. */
export const NewPaneIdSchema = S.String.pipe(
  S.check(
    S.makeFilter((value) => NEW_PANE_ID_RE.test(value), {
      message: "pane id must be '{space}:p{number}'",
    }),
  ),
);
export type NewPaneId = typeof NewPaneIdSchema.Type;

/** Leaf pane id in results and context — any non-empty string (fixtures included). */
export const PaneIdSchema = NonEmptyString;
export type PaneId = typeof PaneIdSchema.Type;

export const NewPaneIdPartsSchema = S.Struct({
  space: NonEmptyString,
  number: PositiveInt,
});
export type NewPaneIdParts = typeof NewPaneIdPartsSchema.Type;

/**
 * String ↔ `{ space, number }` through the one hierarchical pane-id regex.
 * Apply and adoption use this; not part of the plugin API surface.
 */
export const NewPaneIdPartsFromStringSchema = NewPaneIdSchema.pipe(
  S.decodeTo(NewPaneIdPartsSchema, {
    decode: SchemaGetter.transformOrFail((id: string) => {
      const match = NEW_PANE_ID_RE.exec(id);
      if (match === null || match[1] === undefined || match[2] === undefined) {
        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: "pane id must be '{space}:p{number}'" }),
        );
      }
      return Effect.succeed({ space: match[1], number: Number(match[2]) });
    }),
    encode: SchemaGetter.transform((parts: NewPaneIdParts) =>
      makePaneId(parts.space, parts.number),
    ),
  }),
);

/** Mint a fresh session id. Collision is left to apply's uniqueness check. */
export const makeSessionId: Effect.Effect<SessionId> = Effect.sync(() => `agent-${randomUUID()}`);

/** Build a hierarchical pane id from a space id and pane number. */
export const makePaneId = (spaceId: string, number: number): NewPaneId => `${spaceId}:p${number}`;
