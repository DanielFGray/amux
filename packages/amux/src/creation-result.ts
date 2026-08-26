import { Schema as S } from "effect";

export const CREATION_ENTITY_SCHEMAS = {
  space: S.String,
  window: S.Int,
  pane: S.String,
  session: S.String,
} as const;

export type CreationEntity = keyof typeof CREATION_ENTITY_SCHEMAS;

export const CREATION_ENTITIES = Object.keys(CREATION_ENTITY_SCHEMAS) as CreationEntity[];

export const CREATION_RESULT_ENTITIES = {
  "agent.new": ["session", "pane"],
  "pane.split": ["session", "pane"],
  "window.new": ["window", "pane", "session"],
  "space.new": ["space", "window", "pane", "session"],
} as const satisfies Record<string, readonly CreationEntity[]>;

export type CreationCommand = keyof typeof CREATION_RESULT_ENTITIES;

export type CreationResult<T extends CreationCommand = CreationCommand> = T extends CreationCommand
  ? {
      readonly [K in (typeof CREATION_RESULT_ENTITIES)[T][number]]: S.Schema.Type<
        (typeof CREATION_ENTITY_SCHEMAS)[K]
      >;
    }
  : never;

export function creationResultSchema<T extends CreationCommand>(tag: T) {
  return S.Struct(
    Object.fromEntries(
      CREATION_RESULT_ENTITIES[tag].map((entity) => [entity, CREATION_ENTITY_SCHEMAS[entity]]),
    ) as {
      [K in (typeof CREATION_RESULT_ENTITIES)[T][number]]: (typeof CREATION_ENTITY_SCHEMAS)[K];
    },
  );
}
