/**
 * Test-only: nest a JSON value into {@link OwnerJsonText} when a test builds a
 * {@link RegisteredCommand} without an owner fields Schema (invalid args,
 * unregistered tags). Product code uses encodeRegisteredCommand.
 */
import { Effect, Schema as S, SchemaIssue } from "effect";
import { CommandError } from "./commands.ts";
import { OwnerJsonText } from "./layout.ts";

const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

export const nestOwnerArgs = (
  value: typeof OwnerJsonText.Encoded,
): Effect.Effect<OwnerJsonText, CommandError> =>
  S.decodeEffect(OwnerJsonText)(value).pipe(
    Effect.mapError(
      (error) =>
        new CommandError({
          message: formatSchemaIssue(error.issue),
        }),
    ),
  );
