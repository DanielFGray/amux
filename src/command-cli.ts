import { COMMAND_DEFS, COMMAND_META, type CommandTag } from "./commands.ts";

/**
 * Field metadata derived from each command's schema fields.
 * Keyed by command tag, mapping field name → kind.
 */
type FieldKind = "string" | "int" | "boolean" | "literal";
type FieldShape = { name: string; kind: FieldKind; required: boolean; literals?: readonly string[] };

const FIELD_KINDS: Record<string, Record<string, FieldShape>> = {};

function registerFields(
  tag: CommandTag,
  shapes: [string, FieldKind, { required?: boolean; literals?: readonly string[] }?][],
) {
  const fields: Record<string, FieldShape> = {};
  for (const [name, kind, opts] of shapes) {
    fields[name] = { name, kind, required: opts?.required ?? true, literals: opts?.literals };
  }
  FIELD_KINDS[tag] = fields;
}

// Register field metadata for each command. Must stay in sync with commands.ts.
registerFields("pane.split", [["axis", "literal", { literals: ["row", "column"] }]]);
registerFields("pane.next", []);
registerFields("pane.last", []);
registerFields("pane.focus", [["direction", "literal", { literals: ["left", "right", "up", "down"] }]]);
registerFields("pane.select", [["pane", "string"]]);
registerFields("pane.resize", [["direction", "literal", { literals: ["left", "right", "up", "down"] }]]);
registerFields("pane.resize-divider", [
  ["path", "string"], ["index", "int"], ["delta", "int"],
]);
registerFields("pane.zoom", []);
registerFields("pane.swap", [["to", "literal", { literals: ["previous", "next"] }]]);
registerFields("pane.close", []);
registerFields("pane.break", []);
registerFields("pane.join", [["source", "int", { required: false }]]);
registerFields("pane.move", [["space", "string"]]);
registerFields("pane.send-keys", [["keys", "string"]]);
registerFields("pane.capture", []);
registerFields("pane.copy-mode", []);

registerFields("buffer.set", [["name", "string", { required: false }], ["data", "string"]]);
registerFields("buffer.paste", [["name", "string", { required: false }]]);
registerFields("buffer.list", []);
registerFields("buffer.delete", [["name", "string", { required: false }]]);
registerFields("buffer.show", [["name", "string", { required: false }]]);
registerFields("buffer.choose", []);

registerFields("window.new", []);
registerFields("window.next", []);
registerFields("window.previous", []);
registerFields("window.last", []);
registerFields("window.select", [["space", "string", { required: false }], ["number", "int"]]);
registerFields("window.rename", [
  ["space", "string", { required: false }], ["window", "int", { required: false }], ["name", "string"],
]);
registerFields("window.close", [
  ["space", "string", { required: false }], ["window", "int", { required: false }],
]);
registerFields("window.next-layout", []);
registerFields("window.select-layout", [
  ["preset", "string"] as [string, FieldKind], // coerce to string, validated by schema
]);
registerFields("window.synchronize-panes", []);

registerFields("agent.kill", [["agent", "string", { required: false }]]);
registerFields("agent.reveal", [["agent", "string"]]);
registerFields("agent.next-blocked", []);

registerFields("space.new", [
  ["name", "string", { required: false }], ["dir", "string", { required: false }],
  ["branch", "string", { required: false }], ["base", "string", { required: false }],
]);
registerFields("space.select", [["space", "string"]]);
registerFields("space.rename", [
  ["space", "string", { required: false }], ["name", "string"],
]);
registerFields("space.close", [["space", "string", { required: false }]]);
registerFields("space.next", []);
registerFields("space.previous", []);

registerFields("config.set", [["name", "string"], ["value", "string"]]);
registerFields("config.toggle", [["name", "string"]]);
registerFields("config.adjust", [["name", "string"], ["by", "int"]]);
registerFields("config.reset", [["name", "string"]]);

registerFields("app.help", []);
registerFields("app.command-palette", []);
registerFields("app.settings", []);
registerFields("app.send-prefix", []);
registerFields("app.quit", []);

export function fieldNames(tag: CommandTag): FieldShape[] {
  return Object.values(FIELD_KINDS[tag] ?? {});
}

export function parseArgs(tag: CommandTag, argv: string[]): {
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
      if (!field) { errors.push(`unknown flag: --${name}`); continue; }
      if (consumed.has(name)) { errors.push(`duplicate flag: --${name}`); continue; }
      const coerced = coerce(value, field);
      if (coerced === undefined) { errors.push(`invalid value for --${name}: ${JSON.stringify(value)}`); continue; }
      parsed[name] = coerced;
      consumed.add(name);
      continue;
    }

    if (positionalIdx >= requiredFields.length) { errors.push(`unexpected argument: ${arg}`); continue; }
    const field = requiredFields[positionalIdx++]!;
    const coerced = coerce(arg, field);
    if (coerced === undefined) { errors.push(`invalid value for '${field.name}': ${JSON.stringify(arg)}`); continue; }
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
    const fieldStr = fields.map((f) =>
      f.required ? `<${f.name}>` : `[${f.name}]`
    ).join(" ");
    const entry = `    ${def.tag} ${fieldStr}`.trimEnd() + `\n        ${def.desc}`;
    const groupEntries = groups.get(def.group) ?? [];
    groupEntries.push(entry);
    groups.set(def.group, groupEntries);
  }

  for (const group of [...groups.keys()].sort()) {
    lines.push(`  ${group}:`);
    lines.push(...(groups.get(group)!));
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
