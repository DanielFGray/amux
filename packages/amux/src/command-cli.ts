import { Match, Option, Schema as S } from "effect";
import { COMMAND_DEFS, COMMAND_META, type CommandTag } from "./commands.ts";
import { JsonValueSchema, type JsonValue } from "./effect/AttachProtocol.ts";

/**
 * Field metadata derived from each command's schema fields.
 * Keyed by command tag, mapping field name → kind.
 */
type FieldSpec =
  | { name: string; kind: "string"; required: boolean }
  | { name: string; kind: "int"; required: boolean; minimum?: number }
  | { name: string; kind: "boolean"; required: boolean }
  | { name: string; kind: "literal"; required: boolean; literals: readonly string[] }
  | { name: string; kind: "array"; required: boolean };

type JsonSchemaObject = {
  properties?: Record<string, JsonSchemaObject>;
  required?: readonly string[];
  type?: string;
  enum?: readonly string[];
  items?: JsonSchemaObject;
  $ref?: string;
  $defs?: Record<string, JsonSchemaObject>;
  anyOf?: readonly JsonSchemaObject[];
  minimum?: number;
};

function commandSchema(tag: CommandTag): JsonSchemaObject {
  const def = COMMAND_DEFS.find((item) => item.tag === tag);
  if (!def) throw new Error(`unknown command: ${tag}`);
  const document = S.toJsonSchemaDocument(def.arguments);
  const schema = document.schema as JsonSchemaObject;
  if (Object.keys(document.definitions).length > 0) {
    schema.$defs = document.definitions as Record<string, JsonSchemaObject>;
  }
  return schema;
}

/** Optional fields encode as `anyOf: [<type>, {type: "null"}]`; unwrap to the real branch. */
function resolveSchema(schema: JsonSchemaObject, root: JsonSchemaObject): JsonSchemaObject {
  const key = schema.$ref?.match(/^#\/\$defs\/(.+)$/)?.[1];
  const dereferenced = key && root.$defs?.[key] ? root.$defs[key]! : schema;
  const nonNull = dereferenced.anyOf?.filter((branch) => branch.type !== "null");
  if (nonNull?.length === 1) return resolveSchema(nonNull[0]!, root);
  return dereferenced;
}

function fieldSpec(
  name: string,
  schema: JsonSchemaObject,
  root: JsonSchemaObject,
  required: boolean,
): FieldSpec {
  const resolved = resolveSchema(schema, root);
  if (resolved.enum) return { name, kind: "literal", required, literals: resolved.enum };
  if (resolved.type === "integer")
    return { name, kind: "int", required, minimum: resolved.minimum };
  if (resolved.type === "boolean") return { name, kind: "boolean", required };
  if (resolved.type === "array") return { name, kind: "array", required };
  return { name, kind: "string", required };
}

export function fieldNames(tag: CommandTag): FieldSpec[] {
  const schema = commandSchema(tag);
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, field]) =>
    fieldSpec(name, field, schema, required.has(name)),
  );
}

export interface ParseArgsResult {
  parsed: Record<string, JsonValue> | null;
  errors: string[];
}

export function parseArgs(tag: CommandTag, argv: string[]): ParseArgsResult {
  const fields = fieldNames(tag);
  if (fields.length === 0) {
    for (const arg of argv) {
      if (arg.startsWith("--")) return { parsed: null, errors: [`unknown flag: ${arg}`] };
    }
    if (argv.length > 0) return { parsed: null, errors: [`command '${tag}' takes no arguments`] };
    return { parsed: {}, errors: [] };
  }

  const parsed: Record<string, JsonValue> = {};
  const errors: string[] = [];
  const consumed = new Set<string>();
  const requiredFields = fields.filter((f) => f.required);
  let positionalIdx = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const flagMatch = arg.match(/^--([a-zA-Z][a-zA-Z0-9_-]*)(?:=(.*))?$/);
    if (flagMatch) {
      const name = flagMatch[1]!;
      const field = fields.find((f) => f.name === name);
      if (!field) {
        errors.push(`unknown flag: --${name}`);
        continue;
      }
      // A boolean flag consumes a separated value only when that value parses
      // as a boolean; otherwise a bare `--current` would swallow the positional
      // that follows it. Value-taking flags consume the next token unless it
      // looks like a flag.
      const next = argv[i + 1];
      const takesSeparatedValue =
        flagMatch[2] === undefined &&
        next !== undefined &&
        !next.startsWith("--") &&
        (field.kind !== "boolean" || coerce(next, field) !== undefined);
      const value = flagMatch[2] ?? (takesSeparatedValue ? argv[++i] : undefined);
      if (consumed.has(name)) {
        errors.push(`duplicate flag: --${name}`);
        continue;
      }
      const coerced = coerce(value, field);
      if (coerced === undefined) {
        errors.push(`invalid value for --${name}: ${JSON.stringify(value)}`);
        continue;
      }
      parsed[name] = coerced;
      consumed.add(name);
      continue;
    }

    if (positionalIdx >= requiredFields.length) {
      errors.push(`unexpected argument: ${arg}`);
      continue;
    }
    const field = requiredFields[positionalIdx++]!;
    const coerced = coerce(arg, field);
    if (coerced === undefined) {
      errors.push(`invalid value for '${field.name}': ${JSON.stringify(arg)}`);
      continue;
    }
    parsed[field.name] = coerced;
    consumed.add(field.name);
  }

  for (const field of fields) {
    if (field.required && !(field.name in parsed)) {
      errors.push(`missing required argument: ${field.name}`);
    }
  }

  if (errors.length > 0) return { parsed: null, errors };
  return { parsed, errors: [] };
}

function coerce(value: string | undefined, field: FieldSpec): JsonValue | undefined {
  if (value === undefined) {
    if (field.kind === "boolean") return true;
    return undefined;
  }
  return Match.value(field).pipe(
    Match.discriminatorsExhaustive("kind")({
      string: () => value,
      literal: (f) => (f.literals.includes(value) ? value : undefined),
      int: (f) => {
        const n = Number(value);
        if (!Number.isSafeInteger(n)) return undefined;
        if (f.minimum !== undefined && n < f.minimum) return undefined;
        return n;
      },
      array: () => {
        const parsed = S.decodeOption(S.fromJsonString(S.Array(JsonValueSchema)))(value);
        return Option.getOrUndefined(parsed);
      },
      boolean: () => {
        if (value === "true" || value === "1") return true;
        if (value === "false" || value === "0") return false;
        return undefined;
      },
    }),
  );
}

/**
 * Args for a plugin verb, e.g. `--key=value`.
 *
 * A core command's flags are checked against the schema it declared
 * (`parseArgs`, above); a plugin's schema lives only in whichever client
 * loaded it; the CLI process never sees it. Each value decodes as JSON when
 * it parses that way (so `--count=3` and `--enabled=true` reach the plugin
 * as a number and a boolean), falling back to the raw string otherwise.
 */
export function parsePluginArgs(argv: readonly string[]): ParseArgsResult {
  const parsed: Record<string, JsonValue> = {};
  const errors: string[] = [];
  for (const arg of argv) {
    const flagMatch = arg.match(/^--([a-zA-Z][a-zA-Z0-9_-]*)=(.*)$/);
    if (!flagMatch) {
      errors.push(`plugin commands take only --key=value flags: ${arg}`);
      continue;
    }
    const [, name, raw] = flagMatch as [string, string, string];
    const decoded = S.decodeOption(S.fromJsonString(JsonValueSchema))(raw);
    parsed[name] = Option.getOrElse(decoded, () => raw);
  }
  if (errors.length > 0) return { parsed: null, errors };
  return { parsed, errors: [] };
}

export function commandGroups(): readonly string[] {
  return [
    ...new Set(COMMAND_DEFS.filter((def) => def.target !== "view").map((def) => def.group)),
  ].sort();
}

export function generateGroupHelp(group: string): string | undefined {
  const definitions = COMMAND_DEFS.filter((def) => def.target !== "view" && def.group === group);
  if (definitions.length === 0) return undefined;

  return [
    `usage: amux ${group} <command> [args] [--session=<id>]`,
    "",
    `${group}:`,
    ...definitions.flatMap(commandHelp),
  ].join("\n");
}

export function generateHelp(): string {
  const lines: string[] = [
    "usage: amux <command> [args] [--flag=value] [--session=<id>]",
    "       amux <command> [args] \\; <command> [args] ...",
    "       amux process-state --state <idle|running|blocked|done>",
    "",
    "Commands:",
  ];

  const groups = new Map<string, string[]>();
  for (const def of COMMAND_DEFS) {
    if (def.target === "view") continue;
    const entry = commandHelp(def);
    const groupEntries = groups.get(def.group) ?? [];
    groupEntries.push(entry);
    groups.set(def.group, groupEntries);
  }

  for (const group of [...groups.keys()].sort()) {
    lines.push(`  ${group}:`);
    lines.push(...groups.get(group)!);
  }

  lines.push("");
  lines.push("  daemon [id]       start a session daemon");
  lines.push("  status [id]       print a session's status as JSON");
  lines.push("  stop [id]         stop a session");
  lines.push("  list              list known sessions and whether each is running");
  lines.push("");
  lines.push("  amux new <session-id>   create a session (or resume a stopped one) and attach");
  lines.push("  amux <session-id>       attach to an existing session");
  lines.push("  amux                    attach to the 'default' session, creating it if needed");
  return lines.join("\n");
}

function commandHelp(def: (typeof COMMAND_DEFS)[number]): string {
  const syntax = fieldNames(def.tag)
    .map((field) => {
      const value = field.kind === "literal" ? field.literals.join("|") : field.name;
      if (field.required) return `<${value}>`;
      // A boolean is set by naming it, so showing it as `--flag=<flag>` tells
      // the reader to invent a value. The parser accepts the bare form, and
      // this CLI's audience reads the usage line as the contract.
      return field.kind === "boolean" ? `[--${field.name}]` : `[--${field.name}=<${value}>]`;
    })
    .join(" ");
  return `  ${def.tag} ${syntax}`.trimEnd() + `\n      ${COMMAND_META[def.tag].desc}`;
}
