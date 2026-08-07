import { JSONSchema } from "effect";
import { COMMAND_DEFS, COMMAND_META, type CommandTag } from "./commands.ts";

/**
 * Field metadata derived from each command's schema fields.
 * Keyed by command tag, mapping field name → kind.
 */
type FieldKind = "string" | "int" | "boolean" | "literal" | "array";
type FieldShape = {
  name: string;
  kind: FieldKind;
  required: boolean;
  literals?: readonly string[];
};

type JsonSchemaObject = ReturnType<typeof JSONSchema.make> & {
  properties?: Record<string, JsonSchemaObject>;
  required?: readonly string[];
  type?: string;
  enum?: readonly string[];
  items?: JsonSchemaObject;
  $ref?: string;
  $defs?: Record<string, JsonSchemaObject>;
};

function commandSchema(tag: CommandTag): JsonSchemaObject {
  const def = COMMAND_DEFS.find((item) => item.tag === tag);
  if (!def) throw new Error(`unknown command: ${tag}`);
  return JSONSchema.make(def.arguments) as JsonSchemaObject;
}

function resolveSchema(schema: JsonSchemaObject, root: JsonSchemaObject): JsonSchemaObject {
  const key = schema.$ref?.match(/^#\/\$defs\/(.+)$/)?.[1];
  return key && root.$defs?.[key] ? root.$defs[key]! : schema;
}

function fieldShape(
  name: string,
  schema: JsonSchemaObject,
  root: JsonSchemaObject,
  required: boolean,
): FieldShape {
  const resolved = resolveSchema(schema, root);
  if (resolved.enum) return { name, kind: "literal", required, literals: resolved.enum };
  if (resolved.type === "integer") return { name, kind: "int", required };
  if (resolved.type === "boolean") return { name, kind: "boolean", required };
  if (resolved.type === "array") return { name, kind: "array", required };
  return { name, kind: "string", required };
}

export function fieldNames(tag: CommandTag): FieldShape[] {
  const schema = commandSchema(tag);
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, field]) =>
    fieldShape(name, field, schema, required.has(name)),
  );
}

export function parseArgs(
  tag: CommandTag,
  argv: string[],
): {
  parsed: Record<string, unknown> | null;
  errors: string[];
} {
  const fields = fieldNames(tag);
  if (fields.length === 0) {
    for (const arg of argv) {
      if (arg.startsWith("--")) return { parsed: null, errors: [`unknown flag: ${arg}`] };
    }
    if (argv.length > 0) return { parsed: null, errors: [`command '${tag}' takes no arguments`] };
    return { parsed: {}, errors: [] };
  }

  const parsed: Record<string, unknown> = {};
  const errors: string[] = [];
  const consumed = new Set<string>();
  const requiredFields = fields.filter((f) => f.required);
  let positionalIdx = 0;

  for (const arg of argv) {
    const flagMatch = arg.match(/^--([a-zA-Z][a-zA-Z0-9_-]*)(?:=(.*))?$/);
    if (flagMatch) {
      const name = flagMatch[1]!;
      const value = flagMatch[2];
      const field = fields.find((f) => f.name === name);
      if (!field) {
        errors.push(`unknown flag: --${name}`);
        continue;
      }
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

function coerce(value: string | undefined, field: FieldShape): unknown {
  if (value === undefined) {
    if (field.kind === "boolean") return true;
    return undefined;
  }
  switch (field.kind) {
    case "string":
    case "literal":
      return value;
    case "int": {
      const n = Number(value);
      if (!Number.isSafeInteger(n)) return undefined;
      return n;
    }
    case "array": {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    case "boolean": {
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      return undefined;
    }
    default:
      return value;
  }
}

export function generateHelp(): string {
  const lines: string[] = [
    "usage: amux <command> [args] [--flag=value] [--session=<id>]",
    "",
    "Commands:",
  ];

  const groups = new Map<string, string[]>();
  for (const def of COMMAND_DEFS) {
    if (def.target === "view") continue;
    const fields = fieldNames(def.tag);
    const fieldStr = fields.map((f) => (f.required ? `<${f.name}>` : `[${f.name}]`)).join(" ");
    const entry = `    ${def.tag} ${fieldStr}`.trimEnd() + `\n        ${def.desc}`;
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
  lines.push("");
  lines.push("  amux [session-id]   attach to a session (autostart daemon);");
  lines.push("                        defaults to 'default'");
  return lines.join("\n");
}
