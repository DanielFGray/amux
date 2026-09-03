import { ProcessState, type ScreenRegion } from "@danielfgray/amux";
import { AgentManifests } from "./manifests.ts";

type DetectorState = ProcessState | "unknown";
interface RegexPattern {
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
  readonly state: DetectorState;
  readonly priority: number;
  readonly region: ScreenRegion;
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
export interface DetectorResult {
  readonly state: DetectorState;
  readonly rule?: string;
  readonly skipStateUpdate: boolean;
  readonly visibleWorking?: boolean;
  readonly visibleIdle?: boolean;
  readonly visibleBlocker?: boolean;
}
interface CompiledAdapter {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly rules: readonly CompiledRule[];
}
interface CompiledRule {
  readonly rule: AdapterRule;
  readonly matches: (text: string) => boolean;
}

export const DETECTOR_REGIONS: readonly ScreenRegion[] = Object.freeze([
  ...new Set(
    AgentManifests.manifests.flatMap((manifest) => manifest.rules.map((rule) => rule.region)),
  ),
]);

const compiledAdapters = new Map<string, CompiledAdapter>();

function adapterFor(agent: string): CompiledAdapter {
  const adapter = AgentManifests.adapterFor(agent);
  const cached = compiledAdapters.get(adapter.id);
  if (cached) return cached;
  const compiled = compileAdapter(adapter);
  compiledAdapters.set(adapter.id, compiled);
  return compiled;
}
function compileAdapter(adapter: Adapter): CompiledAdapter {
  return {
    id: adapter.id,
    aliases: adapter.aliases ?? [],
    rules: adapter.rules.map((rule) => ({ rule, matches: compileGate(rule) })),
  };
}
function compileGate(gate: RuleGate): (text: string) => boolean {
  const contains = (gate.contains ?? []).map((value) => value.toLowerCase());
  const regex = (gate.regex ?? []).map(compileRegex);
  const lineRegex = (gate.line_regex ?? []).map(compileRegex);
  const all = (gate.all ?? []).map(compileGate);
  const any = (gate.any ?? []).map(compileGate);
  const not = (gate.not ?? []).map(compileGate);
  return (text) => {
    const lower = text.toLowerCase();
    return (
      contains.every((value) => lower.includes(value)) &&
      regex.every((pattern) => pattern.test(text)) &&
      lineRegex.every((pattern) => text.split("\n").some((line) => pattern.test(line))) &&
      all.every((matches) => matches(text)) &&
      (any.length === 0 || any.some((matches) => matches(text))) &&
      not.every((matches) => !matches(text))
    );
  };
}
function compileRegex(value: RegexPattern): RegExp {
  return new RegExp(value.pattern, value.flags);
}

export function evaluateAdapter(
  adapter: Adapter,
  regions: Readonly<Record<string, string>>,
): DetectorResult {
  return evaluateCompiledAdapter(compileAdapter(adapter), regions);
}
export function evaluateAgent(
  agent: string,
  regions: Readonly<Record<string, string>>,
): DetectorResult {
  return evaluateCompiledAdapter(adapterFor(agent), regions);
}
function evaluateCompiledAdapter(
  adapter: CompiledAdapter,
  regions: Readonly<Record<string, string>>,
): DetectorResult {
  let matched: CompiledRule | undefined;
  for (const candidate of adapter.rules) {
    if (!candidate.matches(regions[candidate.rule.region] ?? "")) continue;
    if (!matched || candidate.rule.priority > matched.rule.priority) matched = candidate;
  }
  if (!matched) return { state: "unknown", skipStateUpdate: false };
  const { rule } = matched;
  return {
    state: rule.state,
    rule: rule.id,
    skipStateUpdate: rule.skip_state_update ?? false,
    visibleWorking: rule.visible_working && rule.state === ProcessState.Running,
    visibleIdle: rule.visible_idle && rule.state === ProcessState.Idle,
    visibleBlocker: rule.visible_blocker && rule.state === ProcessState.Blocked,
  };
}
