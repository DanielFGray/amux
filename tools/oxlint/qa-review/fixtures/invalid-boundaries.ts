import { Schema } from "effect";

const UserShape = Schema.Struct({ name: Schema.String });

export function forwardUnknown(input: unknown): unknown {
  return input;
}

export function handParse(input: unknown) {
  return typeof input === "string" ? input.trim() : input;
}

export const omitted = (enabled: boolean) => ({
  ...(enabled ? { enabled } : {}),
});

const widened: unknown = { name: "Ada" };
const asserted = widened as { name: string };

const chained = { name: "Ada" } as unknown as { name: string };

/** Banned by name. */
export type JsonValue = string;
export interface JsonValueSchema {
  n: number;
}
export const JsonValueSchema = Schema.Unknown;

/** Banned as a recursive open JSON bag under another name. */
export type OpenJson =
  | string
  | number
  | boolean
  | null
  | readonly OpenJson[]
  | { readonly [key: string]: OpenJson };

/** Banned: renamed JsonValueSchema body (recursive Array + Record of self). */
export const OpenJsonSchema = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.String,
    Schema.Boolean,
    Schema.Number,
    Schema.Array(OpenJsonSchema),
    Schema.Record(Schema.String, OpenJsonSchema),
  ]),
);

void UserShape;
void asserted;
void chained;
void JsonValueSchema;
void OpenJsonSchema;
