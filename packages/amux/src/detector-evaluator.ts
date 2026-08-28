import { Context, Effect, Layer } from "effect";
import { ProcessState } from "./process-state.ts";
import { extractScreenRegion, type ScreenRegion, type ScreenSnapshot } from "./screen-regions.ts";

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

export interface DetectorEvaluatorService {
  evaluate(agent: string, snapshot: ScreenSnapshot): DetectorResult;
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

/** Evaluates closed adapter data. Plugins can provide this service when their
 * detector needs behavior the shared rule vocabulary cannot express. */
export class DetectorEvaluator extends Context.Service<
  DetectorEvaluator,
  DetectorEvaluatorService
>()("amux/DetectorEvaluator") {
  static readonly core: DetectorEvaluatorService = {
    evaluate: (agent, snapshot) => evaluateCompiledAdapter(adapterFor(agent), snapshot),
  };

  static readonly Default = Layer.succeed(DetectorEvaluator, DetectorEvaluator.core);

  static evaluate(
    agent: string,
    snapshot: ScreenSnapshot,
  ): Effect.Effect<DetectorResult, never, DetectorEvaluator> {
    return Effect.map(DetectorEvaluator, (evaluator) => evaluator.evaluate(agent, snapshot));
  }
}

export function evaluateAdapter(adapter: Adapter, snapshot: ScreenSnapshot): DetectorResult {
  return evaluateCompiledAdapter(compileAdapter(adapter), snapshot);
}

const COMMON_RULES: readonly AdapterRule[] = [
  {
    id: "osc_title_working",
    state: ProcessState.Running,
    priority: 1_100,
    region: "osc_title",
    visible_working: true,
    regex: [{ pattern: "^[\\u2800-\\u28ff·✢✳✶✻✽]\\s" }],
  },
  {
    id: "confirmation_prompt",
    state: ProcessState.Blocked,
    priority: 500,
    region: "bottom_lines(20)",
    any: [
      { regex: [{ pattern: "Do you want to (proceed|continue|make this edit)", flags: "i" }] },
      { regex: [{ pattern: "❯\\s*1\\.\\s*Yes" }] },
      { line_regex: [{ pattern: "\\bAllow\\b.*\\?\\s*$", flags: "i" }] },
      { contains: ["[y/n]"] },
      { contains: ["(y/n)"] },
      { regex: [{ pattern: "Press\\s+(enter|return)\\s+to\\s+continue", flags: "i" }] },
      { regex: [{ pattern: "Waiting for (your )?(input|response|approval)", flags: "i" }] },
    ],
  },
];

const CLAUDE: Adapter = {
  id: "claude",
  aliases: ["claude-code"],
  rules: [
    ...COMMON_RULES,
    {
      id: "model_picker_menu",
      state: "unknown",
      priority: 900,
      region: "whole_recent",
      skip_state_update: true,
      contains: ["select model", "enter to set as default", "esc to cancel"],
      not: [{ contains: ["do you want to proceed?"] }, { contains: ["enter to select"] }],
    },
  ],
};

const OPENCODE: Adapter = { id: "opencode", aliases: ["open-code"], rules: COMMON_RULES };
const FALLBACK: Adapter = { id: "default", rules: COMMON_RULES };

const ADAPTERS = [CLAUDE, OPENCODE].map(compileAdapter);
const COMPILED_FALLBACK = compileAdapter(FALLBACK);

function adapterFor(agent: string): CompiledAdapter {
  const id = agent.toLowerCase();
  return (
    ADAPTERS.find((adapter) => adapter.id === id || adapter.aliases.includes(id)) ??
    COMPILED_FALLBACK
  );
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

function evaluateCompiledAdapter(
  adapter: CompiledAdapter,
  snapshot: ScreenSnapshot,
): DetectorResult {
  let matched: CompiledRule | undefined;
  for (const candidate of adapter.rules) {
    if (!candidate.matches(extractScreenRegion(snapshot, candidate.rule.region))) continue;
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
