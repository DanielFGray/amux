/**
 * Writing or improving an agent manifest
 * =======================================
 *
 * A manifest tells amux two things about one coding agent: which
 * executables identify it, and how to read its on-screen state from a
 * terminal snapshot. `manifests.json` bundles the manifests amux ships with;
 * anyone can add or override one locally without touching this package's
 * source, by dropping a file at:
 *
 *   ${XDG_CONFIG_HOME:-~/.config}/amux/agent-detection/<id>.json
 *
 * The filename (minus `.json`) must equal the manifest's own `id` field —
 * that's how it's matched to a bundled entry. A local file with a matching
 * id *replaces* the bundled one wholesale (not merged field-by-field); a new
 * id with no bundled counterpart adds a new agent. Take effect immediately
 * on the next amux launch — no rebuild, no restart of anything else. A file
 * that fails to parse or fails schema validation (see below) is silently
 * skipped, so a work-in-progress manifest can be edited and re-tested by
 * just restarting amux, without risk of crashing the plugin.
 *
 * Shape of a manifest:
 *
 *   {
 *     "id": "my-agent",              // matches the filename above
 *     "version": "1",                // free-form, for your own tracking
 *     "min_engine_version": 1,       // must be <= MANIFEST_ENGINE_VERSION below
 *     "executables": ["my-agent"],   // argv[0] basenames that identify it
 *     "aliases": ["myAgentCLI"],     // optional: extra names adapterFor() accepts
 *     "rules": [ ... ]               // see below
 *   }
 *
 * Each rule reads one named screen region and, if it matches, reports a
 * state. `region` is one of `screen-regions.ts`'s `ScreenRegion` values
 * (`osc_title`, `osc_progress`, `prompt_box_body`, `whole_recent`,
 * `after_last_horizontal_rule`, `after_last_prompt_marker`,
 * `above_prompt_box`, `last_non_empty_above_prompt_box`,
 * `bottom_lines(N)`, `bottom_non_empty_lines(N)`). `state` is one of
 * `"idle" | "running" | "blocked" | "done" | "unknown"`.
 *
 * A rule matches when its gate matches the region's text. A gate is:
 *
 *   - `contains`: every string listed must appear (case-insensitive) — an
 *     AND, not an OR. Use nested `any: [{contains: [...]}, ...]` for "one of".
 *   - `regex` / `line_regex`: every pattern must match — `regex` against the
 *     whole region text, `line_regex` against at least one line of it.
 *   - `all` / `any` / `not`: nested gates, combined the obvious way.
 *
 * When more than one rule matches the same snapshot, the rule with the
 * highest `priority` wins — ties are not resolved deterministically, so
 * give competing rules distinct priorities. `visible_working` /
 * `visible_idle` / `visible_blocker` mark a rule's match as screen-visible
 * evidence of its state (surfaced for "explain this pane" tooling);
 * `skip_state_update` marks a rule that identifies a transient screen (e.g.
 * a menu overlay) without asserting anything about the agent's real state.
 *
 * To test a rule without wiring up a live pane, see the fixtures and
 * `evaluateAgent`/`evaluateAdapter` calls in `detector.test.ts` — feed it a
 * region string directly and assert on the returned `state`/`rule`.
 *
 * A plugin's `effect` cannot require `FileSystem.FileSystem` (see the doc
 * comment on `loadLocalOverrides` below), so manifest loading is plain
 * synchronous Node I/O at module scope, not an Effect service.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off
import path from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readdirSync, readFileSync } from "node:fs";
import { Config, Effect, Schema as S } from "effect";
import bundledData from "./manifests.json" with { type: "json" };

export const MANIFEST_ENGINE_VERSION = 1;

/**
 * The data shapes a manifest carries. Owned here rather than by the
 * detector so both core (which reads them as neutral facts) and the
 * agent-awareness plugin (which interprets them) share one definition.
 * `region` and `state` stay wide strings: manifests are validated against
 * the same sets at decode time, and the detector narrows them at its own
 * boundary.
 */
export interface RegexPattern {
  readonly pattern: string;
  readonly flags?: string;
}
export interface RuleGate {
  readonly contains?: readonly string[];
  readonly regex?: readonly RegexPattern[];
  readonly line_regex?: readonly RegexPattern[];
  readonly all?: readonly RuleGate[];
  readonly any?: readonly RuleGate[];
  readonly not?: readonly RuleGate[];
}
export interface AdapterRule extends RuleGate {
  readonly id: string;
  readonly state: string;
  readonly priority: number;
  readonly region: string;
  readonly skip_state_update?: boolean;
  readonly visible_working?: boolean;
  readonly visible_idle?: boolean;
  readonly visible_blocker?: boolean;
}
export interface Adapter {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly rules: readonly AdapterRule[];
}

export interface AgentManifest extends Adapter {
  readonly version: string;
  readonly min_engine_version: number;
  readonly executables: readonly string[];
}

export interface AgentManifestRegistry {
  readonly identifyAgent: (command: string | readonly string[]) => string | null;
  readonly adapterFor: (agent: string) => Adapter;
  readonly manifests: readonly AgentManifest[];
}

interface RegexPatternData {
  readonly pattern: string;
  readonly flags?: string;
}
interface ManifestGateData {
  readonly contains?: readonly string[];
  readonly regex?: readonly RegexPatternData[];
  readonly line_regex?: readonly RegexPatternData[];
  readonly all?: readonly ManifestGateData[];
  readonly any?: readonly ManifestGateData[];
  readonly not?: readonly ManifestGateData[];
}

const RegexPattern: S.Codec<RegexPatternData> = S.Struct({
  pattern: S.String,
  flags: S.optional(S.String),
}).pipe(S.check(S.makeFilter((value) => isValidRegex(value.pattern, value.flags))));

function isValidRegex(pattern: string, flags?: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

const gateFields = () => ({
  contains: S.optional(S.Array(S.String)),
  regex: S.optional(S.Array(RegexPattern)),
  line_regex: S.optional(S.Array(RegexPattern)),
  all: S.optional(S.Array(ManifestGate)),
  any: S.optional(S.Array(ManifestGate)),
  not: S.optional(S.Array(ManifestGate)),
});

const ManifestGate: S.Codec<ManifestGateData> = S.suspend((): S.Codec<ManifestGateData> =>
  S.Struct(gateFields()),
);

/** The screen regions `screen-regions.ts` knows how to extract. Kept in sync
 *  by hand: a manifest region string is untyped JSON, so this is the runtime
 *  boundary that rejects one `extractScreenRegion` would silently ignore.
 *
 *  Deliberately missing `top_non_empty_lines(N)`: herdr's manifest engine
 *  has it, but nothing in the herdr manifests amux currently ports (claude,
 *  codex, opencode, github-copilot) uses it, and `extractScreenRegion`
 *  doesn't implement it either. Add both together if a future port needs it. */
const NAMED_REGIONS = new Set([
  "osc_title",
  "osc_progress",
  "prompt_box_body",
  "after_last_horizontal_rule",
  "after_last_prompt_marker",
  "above_prompt_box",
  "last_non_empty_above_prompt_box",
  "whole_recent",
]);
const isScreenRegion = (value: string): boolean =>
  NAMED_REGIONS.has(value) || /^(?:bottom_non_empty_lines|bottom_lines)\([1-9]\d*\)$/.test(value);

const Region = S.String.pipe(S.check(S.makeFilter(isScreenRegion)));

const hasPositiveMatcher = (gate: ManifestGateData): boolean =>
  Boolean(
    gate.contains?.length ||
    gate.regex?.length ||
    gate.line_regex?.length ||
    gate.all?.length ||
    gate.any?.length,
  );

const ManifestRule = S.Struct({
  ...gateFields(),
  id: S.String.pipe(S.check(S.isMinLength(1))),
  state: S.Literals(["idle", "running", "blocked", "done", "unknown"]),
  priority: S.Finite,
  region: Region,
  skip_state_update: S.optional(S.Boolean),
  visible_working: S.optional(S.Boolean),
  visible_idle: S.optional(S.Boolean),
  visible_blocker: S.optional(S.Boolean),
}).pipe(S.check(S.makeFilter(hasPositiveMatcher)));

const NonEmptyString = S.String.pipe(S.check(S.isMinLength(1)));

const Manifest = S.Struct({
  id: NonEmptyString,
  version: S.String.pipe(S.check(S.isPattern(/^\d+(?:\.\d+)*$/))),
  min_engine_version: S.Int.pipe(
    S.check(S.isBetween({ minimum: 1, maximum: MANIFEST_ENGINE_VERSION })),
  ),
  executables: S.Array(NonEmptyString),
  aliases: S.optional(S.Array(NonEmptyString)),
  rules: S.Array(ManifestRule),
});
const BundledManifests = S.Array(Manifest).pipe(
  S.check(S.makeFilter((manifests) => manifests.some((manifest) => manifest.id === "default"))),
);

const executableName = (token: string): string =>
  token
    .split("/")
    .pop()!
    .replace(/\.(exe|cmd|js|mjs|ts)$/i, "")
    .toLowerCase();

const shellName = Effect.runSync(
  Config.string("SHELL").pipe(
    Config.map((shell) => shell.split("/").pop()?.toLowerCase() ?? ""),
    Config.withDefault(""),
  ),
);
const INTERPRETERS = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "sh",
  "bash",
  "fish",
  "zsh",
  shellName,
]);

function toManifest(manifest: typeof Manifest.Type): AgentManifest {
  return { ...manifest, rules: manifest.rules as readonly AdapterRule[] };
}

function decodeBundled(): readonly AgentManifest[] {
  return S.decodeUnknownSync(BundledManifests, { onExcessProperty: "error" })(bundledData).map(
    toManifest,
  );
}

/** `${XDG_CONFIG_HOME:-~/.config}/amux/agent-detection/<id>.json` replaces a
 *  bundled manifest wholesale when its filename matches the manifest's own
 *  `id`; anything unreadable or mismatched is skipped rather than failing
 *  plugin load. Read synchronously at module load, once: a plugin's `effect`
 *  can only require services declared in `plugin/services.ts`, and
 *  `FileSystem.FileSystem` is not one of them, so there is no Effect-service
 *  path available to a plugin for this read. */
function loadLocalOverrides(configHome: string): readonly AgentManifest[] {
  const directory = path.join(configHome, "amux", "agent-detection");
  let names: readonly string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const overrides: AgentManifest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const text = readFileSync(path.join(directory, name), "utf8");
      const parsed: unknown = JSON.parse(text);
      const manifest = S.decodeUnknownOption(Manifest, { onExcessProperty: "error" })(parsed);
      if (manifest._tag !== "Some") continue;
      if (path.basename(name, ".json") !== manifest.value.id) continue;
      overrides.push(toManifest(manifest.value));
    } catch {
      continue;
    }
  }
  return overrides;
}

function makeRegistry(manifests: readonly AgentManifest[]): AgentManifestRegistry {
  const fallback = manifests.find((manifest) => manifest.id === "default")!;
  const byName = new Map<string, AgentManifest>();
  const byExecutable = new Map<string, string>();
  for (const manifest of manifests) {
    byName.set(manifest.id.toLowerCase(), manifest);
    for (const alias of manifest.aliases ?? []) byName.set(alias.toLowerCase(), manifest);
    for (const executable of manifest.executables)
      byExecutable.set(executable.toLowerCase(), manifest.id);
  }
  return {
    manifests,
    identifyAgent: (command) => identifyFromExecutables(byExecutable, command),
    adapterFor: (agent) => {
      const manifest = byName.get(agent.toLowerCase());
      return manifest && manifest.rules.length > 0 ? manifest : fallback;
    },
  };
}

function identifyFromExecutables(
  executables: ReadonlyMap<string, string>,
  command: string | readonly string[],
): string | null {
  const tokens =
    typeof command === "string" ? command.trim().split(/\s+/).filter(Boolean) : command;
  const first = tokens[0];
  if (!first) return null;
  const base = executableName(first);
  const direct = executables.get(base);
  if (direct) return direct;
  if (!INTERPRETERS.has(base) || !tokens[1]) return null;
  return executables.get(executableName(tokens[1])) ?? null;
}

function loadRegistry(configHome: string): AgentManifestRegistry {
  const bundled = decodeBundled();
  const overrides = new Map(bundled.map((manifest) => [manifest.id, manifest]));
  for (const manifest of loadLocalOverrides(configHome)) overrides.set(manifest.id, manifest);
  return makeRegistry([...overrides.values()]);
}

/** Loaded once at module import: bundled manifests plus whatever local
 *  overrides were present in XDG config at that moment. Every consumer
 *  shares this one instance rather than re-reading the filesystem per call.
 *
 *  The XDG resolution mirrors amux's own config dir rather than importing
 *  it: this package is a support library core and plugins both depend on,
 *  so it cannot import either of them back. */
const FACTS_CONFIG_DIR = Effect.runSync(
  Config.string("XDG_CONFIG_HOME").pipe(
    Config.orElse(() =>
      Config.string("HOME").pipe(Config.map((home) => path.join(home, ".config"))),
    ),
    Config.withDefault(path.join(".", ".config")),
  ),
);
export const AgentManifests: AgentManifestRegistry = loadRegistry(FACTS_CONFIG_DIR);

/** Exposed for tests, which need a registry built against a temp XDG dir
 *  rather than the process's real one. */
export const buildRegistry = (configHome: string): AgentManifestRegistry =>
  loadRegistry(configHome);
