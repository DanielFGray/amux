import { Option, Schema as S, type Types } from "effect";
import { fileURLToPath } from "node:url";
import { keysFor, type CommandSpec, type Keys } from "../bindings.ts";
import { parseClientPluginCommandTag, type CommandMeta } from "../commands.ts";
import type { ContextSpec } from "../key-context.ts";
import type { PaneContent } from "../layout.ts";
import type { Contribution, PluginInstance } from "./contributions.ts";
import type { PluginStatus } from "./types.ts";

/** Who owns a live contribution, plus host/reloader provenance. */
export const PluginProvenanceSchema = S.Struct({
  pluginId: S.String,
  generation: S.optional(S.Int),
  source: S.optional(S.String),
  phase: S.optional(S.String),
  waitingFor: S.Array(S.String),
  active: S.Boolean,
});
export type PluginProvenance = S.Schema.Type<typeof PluginProvenanceSchema>;

export const InspectResultSchema = S.Struct({
  kind: S.Literals(["command", "binding", "key", "pane", "plugin"]),
  name: S.String,
  found: S.Boolean,
  description: S.optional(S.String),
  provider: S.optional(PluginProvenanceSchema),
  whyActive: S.optional(S.String),
  /** Extra facts: bound keys, context id, pane type, waiting deps, … */
  details: S.optional(S.Record(S.String, S.Unknown)),
});
export type InspectResult = S.Schema.Type<typeof InspectResultSchema>;

type Details = Types.Mutable<NonNullable<InspectResult["details"]>>;

export interface InspectQuery {
  readonly command?: string;
  readonly binding?: string;
  readonly key?: string;
  readonly pane?: string;
  readonly plugin?: string;
}

/**
 * Read-only surfaces the inspector needs. Contribution tables already carry
 * owner id+generation; the host and reloader supply phase and source path —
 * no parallel registry.
 */
export interface InspectCatalog {
  readonly bindings: () => readonly Contribution<CommandSpec>[];
  readonly contexts: () => readonly Contribution<ContextSpec>[];
  readonly paneViewOwner: (paneType: string) => PluginInstance | undefined;
  readonly commandMeta: (tag: string) => CommandMeta | undefined;
  readonly pluginStatus: (id: string) => PluginStatus | undefined;
  readonly pluginGeneration: (id: string) => number | undefined;
  readonly pluginSource: (id: string) => URL | undefined;
  readonly paneContent: (paneId: string) => PaneContent | undefined;
  readonly keys: () => Keys;
}

/**
 * Absent facts are omitted keys, never `undefined` values: an inspect result
 * crosses the client socket as owner JSON text, which has no `undefined`.
 */
export const provenanceFor = (
  catalog: InspectCatalog,
  pluginId: string,
  generation?: number,
): PluginProvenance => {
  const status = catalog.pluginStatus(pluginId);
  const source = catalog.pluginSource(pluginId);
  const gen = generation ?? catalog.pluginGeneration(pluginId);
  const provenance: Types.Mutable<PluginProvenance> = {
    pluginId,
    waitingFor: status?.waitingFor ?? [],
    active: status?.phase === "active",
  };
  if (gen !== undefined) provenance.generation = gen;
  if (source !== undefined) provenance.source = fileURLToPath(source);
  if (status !== undefined) provenance.phase = status.phase;
  return provenance;
};

export const inspect = (catalog: InspectCatalog, query: InspectQuery): InspectResult => {
  const subject = exactlyOne(query);
  if (typeof subject === "string") {
    return { kind: "plugin", name: "", found: false, description: subject };
  }

  switch (subject.kind) {
    case "plugin": {
      const status = catalog.pluginStatus(subject.name);
      if (!status && catalog.pluginGeneration(subject.name) === undefined) {
        return { kind: "plugin", name: subject.name, found: false };
      }
      const provider = provenanceFor(catalog, subject.name);
      const details: Details = {};
      if (status?.error !== undefined) details.error = status.error.message;
      if (status?.replacement !== undefined) details.replacementPhase = status.replacement.phase;
      return {
        kind: "plugin",
        name: subject.name,
        found: true,
        provider,
        whyActive: whyPlugin(provider),
        details,
      };
    }
    case "command": {
      const meta = catalog.commandMeta(subject.name);
      const parsed = parseClientPluginCommandTag(subject.name);
      if (!meta && Option.isNone(parsed))
        return { kind: "command", name: subject.name, found: false };
      if (Option.isSome(parsed)) {
        const { pluginId, verb } = parsed.value;
        const provider = provenanceFor(catalog, pluginId);
        const details: Details = { verb };
        const result: Types.Mutable<InspectResult> = {
          kind: "command",
          name: subject.name,
          found: true,
          provider,
          whyActive: whyPlugin(provider),
          details,
        };
        if (meta !== undefined) {
          result.description = meta.desc;
          details.group = meta.group;
          details.target = meta.target;
          details.exposure = meta.exposure;
        }
        return result;
      }
      if (meta === undefined) return { kind: "command", name: subject.name, found: false };
      return {
        kind: "command",
        name: subject.name,
        found: true,
        description: meta.desc,
        provider: coreProvenance(),
        whyActive: "core command (built into the command table)",
        details: { group: meta.group, target: meta.target, exposure: meta.exposure },
      };
    }
    case "binding": {
      const entry = catalog.bindings().find((candidate) => candidate.name === subject.name);
      if (!entry) return { kind: "binding", name: subject.name, found: false };
      const provider = provenanceFor(catalog, entry.owner.id, entry.owner.generation);
      const details: Details = {
        keys: keysFor(entry.value, catalog.keys()),
        group: entry.value.group,
      };
      if (entry.value.context !== undefined) details.context = entry.value.context.id;
      return {
        kind: "binding",
        name: subject.name,
        found: true,
        description: entry.value.desc,
        provider,
        whyActive: whyBinding(entry.value, provider),
        details,
      };
    }
    case "key": {
      const keys = catalog.keys();
      const entry = catalog
        .bindings()
        .find((candidate) => keysFor(candidate.value, keys).includes(subject.name));
      if (!entry) return { kind: "key", name: subject.name, found: false };
      const provider = provenanceFor(catalog, entry.owner.id, entry.owner.generation);
      const details: Details = {
        binding: entry.value.name,
        keys: keysFor(entry.value, keys),
      };
      if (entry.value.context !== undefined) details.context = entry.value.context.id;
      return {
        kind: "key",
        name: subject.name,
        found: true,
        description: entry.value.desc,
        provider,
        whyActive: whyBinding(entry.value, provider),
        details,
      };
    }
    case "pane": {
      const content = catalog.paneContent(subject.name);
      if (!content) return { kind: "pane", name: subject.name, found: false };
      const details: Details = { contentKind: content.kind };
      if (content.session !== undefined) details.session = content.session;
      if (content.kind === "pty") {
        return {
          kind: "pane",
          name: subject.name,
          found: true,
          description: "terminal (pty) pane",
          provider: coreProvenance(),
          whyActive: "core pty pane; no plugin view",
          details,
        };
      }
      details.paneType = content.type;
      const owner = catalog.paneViewOwner(content.type);
      if (!owner) {
        return {
          kind: "pane",
          name: subject.name,
          found: true,
          description: `plugin pane type '${content.type}' has no committed view`,
          whyActive: `pane type '${content.type}' is unregistered or its provider is inactive`,
          details,
        };
      }
      const provider = provenanceFor(catalog, owner.id, owner.generation);
      return {
        kind: "pane",
        name: subject.name,
        found: true,
        description: `plugin pane type '${content.type}'`,
        provider,
        whyActive: whyPlugin(provider),
        details,
      };
    }
  }
};

/**
 * Short human lines for the describe-key panel. Keep it denser than the
 * agent JSON: kind/name, owner+generation, why active, source path.
 */
export const formatInspectResult = (result: InspectResult): readonly string[] => {
  const subject = result.name === "" ? result.kind : `${result.kind}  ${result.name}`;
  if (!result.found) {
    return [subject, result.description ?? "not found"];
  }
  const lines: string[] = [subject];
  if (result.description !== undefined && result.description !== "") {
    lines.push(result.description);
  }
  const provider = result.provider;
  if (provider !== undefined) {
    const gen = provider.generation !== undefined ? `  gen ${provider.generation}` : "";
    lines.push(`owner  ${provider.pluginId}${gen}`);
  }
  if (result.whyActive !== undefined && result.whyActive !== "") {
    lines.push(`why    ${result.whyActive}`);
  }
  if (provider?.source !== undefined && provider.source !== "") {
    lines.push(`source ${provider.source}`);
  }
  const keys = result.details?.keys;
  if (Array.isArray(keys) && keys.length > 0) {
    lines.push(`keys   ${keys.map(String).join(", ")}`);
  }
  const binding = result.details?.binding;
  if (typeof binding === "string" && binding !== "") {
    lines.push(`binds  ${binding}`);
  }
  return lines;
};

const coreProvenance = (): PluginProvenance => ({
  pluginId: "amux",
  waitingFor: [],
  active: true,
  phase: "active",
});

const exactlyOne = (
  query: InspectQuery,
): { kind: InspectResult["kind"]; name: string } | string => {
  const entries = (
    [
      ["command", query.command],
      ["binding", query.binding],
      ["key", query.key],
      ["pane", query.pane],
      ["plugin", query.plugin],
    ] as const
  ).filter(
    (entry): entry is [InspectResult["kind"], string] => entry[1] !== undefined && entry[1] !== "",
  );
  if (entries.length === 0)
    return "plugin.inspect needs one of: command, binding, key, pane, plugin";
  if (entries.length > 1) return "plugin.inspect accepts exactly one subject field";
  return { kind: entries[0]![0], name: entries[0]![1] };
};

const whyPlugin = (prov: PluginProvenance): string => {
  if (prov.waitingFor.length > 0)
    return `plugin '${prov.pluginId}' is waiting for: ${prov.waitingFor.join(", ")}`;
  if (prov.phase === "active") return `plugin '${prov.pluginId}' is active`;
  if (prov.phase !== undefined) return `plugin '${prov.pluginId}' phase is '${prov.phase}'`;
  return `plugin '${prov.pluginId}' has no host status (not in the desired set)`;
};

const whyBinding = (binding: CommandSpec, prov: PluginProvenance): string => {
  const context = binding.context;
  if (context === undefined) return `${whyPlugin(prov)}; global binding`;
  const active = context.active();
  return active
    ? `${whyPlugin(prov)}; context '${context.id}' is active`
    : `${whyPlugin(prov)}; context '${context.id}' is inactive (binding registered, not claiming keys)`;
};
