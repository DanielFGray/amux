/**
 * The gate every tool passes through before it touches anything.
 *
 * The gate is the agent's, not the pane's: the agent holds the pending question,
 * decides which of several answers is the answer, and records what "always"
 * meant. A pane only draws the question and offers a decision, so a second pane
 * on the same session — or a client that has since gone away — cannot change
 * what happened.
 *
 * Approval tiers and modes (OMP docs/approval-mode.md) sit on this same gate —
 * no second approval channel. Resource rules still win first; mode only decides
 * what happens when rules leave the call at "ask".
 */
import { Context, Deferred, Effect, Match, Option, Ref, Schema as S } from "effect";
import * as Path from "effect/Path";
import { randomUUID } from "node:crypto";
import { ProcessState } from "@danielfgray/amux";
import { agentStateTopic } from "./state-topic.ts";
import {
  evaluateAll,
  type PermissionDecision,
  type PermissionEffect,
  type PermissionRule,
} from "@danielfgray/amux/permission.ts";
import type { AgentDelta, AgentEventPayload } from "@danielfgray/amux/protocol";
import type { Interface as ProjectStore } from "@danielfgray/amux/project-store.ts";
import type { JsonValue } from "@danielfgray/amux";
import type { ApprovalMode } from "./options.ts";
import type { HarnessHooks } from "./hooks.ts";
import { emit as toAgentMessage, type HarnessEvent } from "./protocol.ts";

type PermissionStore = Pick<ProjectStore, "addRules">;

/**
 * Tool-declared approval tier — OMP approval-mode.md. Unknown/custom tools
 * default to `exec` (safe). MCP-like tools that only mutate files use `write`.
 */
export const ApprovalTierSchema = S.Literals(["read", "write", "exec"]);
export type ApprovalTier = typeof ApprovalTierSchema.Type;

/** Per-tool override: OMP `tools.approval.<tool>` allow|deny|prompt. */
export const ToolApprovalOverrideSchema = S.Literals(["allow", "deny", "prompt"]);
export type ToolApprovalOverride = typeof ToolApprovalOverrideSchema.Type;

/** What a tool asks the gate: a verb, what it would touch, and how to say it. */
export interface Assertion {
  readonly action: string;
  readonly resources: readonly string[];
  readonly tool: string;
  /** Declared tier; omitted or unknown is treated as `exec`. */
  readonly tier: ApprovalTier;
  readonly input: JsonValue;
  /** The tool-call id from the provider turn, when the handler has one. */
  readonly call?: string;
  /** Prospective unified diff shown in the approve pane before the mutate. */
  readonly diff?: string;
}

export interface PermissionGate {
  /**
   * Clear one tool call, blocking until a human answers if policy says to ask.
   * Fails with the text the model is shown when the call is refused.
   */
  readonly assert: (assertion: Assertion) => Effect.Effect<void, string>;
  /** Answer a pending request. The first answer wins; later ones are dropped. */
  readonly resolve: (
    request: string,
    decision: PermissionDecision,
    feedback?: string,
  ) => Effect.Effect<void>;
}

export class PermissionGateTag extends Context.Service<PermissionGateTag, PermissionGate>()(
  "amux/PermissionGate",
) {}

/**
 * Which tiers a mode auto-approves without asking.
 *
 * | Mode         | Auto-approves     | Prompts for   |
 * | always-ask   | read              | write, exec   |
 * | write        | read, write       | exec          |
 * | yolo         | read, write, exec | none          |
 *
 * Cite: ../oh-my-pi/docs/approval-mode.md § Modes.
 */
export function modeAllows(mode: ApprovalMode, tier: ApprovalTier): boolean {
  return Match.value(mode).pipe(
    Match.when("always-ask", () => tier === "read"),
    Match.when("write", () => tier === "read" || tier === "write"),
    Match.when("yolo", () => true),
    Match.exhaustive,
  );
}

/**
 * Resolve resource-rule effect + mode + per-tool override into allow | ask | deny.
 *
 * Order (extends evaluateAll; does not replace it):
 * 1. Resource or per-tool deny always refuses (OMP: user deny cannot be bypassed).
 * 2. Per-tool prompt forces ask even under yolo.
 * 3. Resource allow (always-persist / project rules) or per-tool allow passes.
 * 4. Mode auto-approves by tier, else ask.
 *
 * Cite OMP approval-mode.md resolution steps 2–6, simplified onto the existing
 * rule vocabulary — still one gate, no second approval channel.
 */
export function resolvePermission(
  resourceEffect: PermissionEffect,
  tier: ApprovalTier,
  mode: ApprovalMode,
  override: ToolApprovalOverride | undefined,
): PermissionEffect {
  if (resourceEffect === "deny" || override === "deny") return "deny";
  if (override === "prompt") return "ask";
  if (resourceEffect === "allow" || override === "allow") return "allow";
  return modeAllows(mode, tier) ? "allow" : "ask";
}

export const makePermissionGate = Effect.fnUntraced(function* (options: {
  readonly session: string;
  readonly turn: Effect.Effect<string>;
  readonly rules: readonly PermissionRule[];
  readonly store: PermissionStore;
  readonly emit: (frame: AgentEventPayload | AgentDelta) => Effect.Effect<void>;
  /** OMP approval mode; default always-ask preserves prior ask-on-write behavior. */
  readonly mode?: ApprovalMode;
  /** Per-tool allow|deny|prompt; cannot override a resource deny. */
  readonly toolApprovals?: Readonly<Record<string, ToolApprovalOverride>>;
  /** Pi-shaped tool_call hooks (ts-b656be); first block wins before policy. */
  readonly hooks?: HarnessHooks;
}) {
  const mode = options.mode ?? "always-ask";
  const toolApprovals = options.toolApprovals ?? {};
  const rules = yield* Ref.make(options.rules);
  const pending = yield* Ref.make(new Map<string, Deferred.Deferred<Answer>>());
  const emitEvent = (event: HarnessEvent) => options.emit(toAgentMessage(options.session, event));

  const answer = (request: string, decision: PermissionDecision, feedback?: string) =>
    Ref.get(pending).pipe(
      Effect.flatMap((map) => {
        const deferred = map.get(request);
        return deferred
          ? Deferred.succeed(deferred, { decision, feedback }).pipe(Effect.asVoid)
          : Effect.void;
      }),
    );

  const emitRequest = (request: string, assertion: Assertion, save: readonly PermissionRule[]) =>
    options.turn.pipe(
      Effect.flatMap((turn) => {
        const event: Extract<HarnessEvent, { _tag: "permission.request" }> = {
          _tag: "permission.request",
          turn,
          request,
          tool: assertion.tool,
          action: assertion.action,
          resources: assertion.resources,
          save,
          input: assertion.input,
        };
        if (assertion.call !== undefined) Object.assign(event, { call: assertion.call });
        if (assertion.diff !== undefined) Object.assign(event, { diff: assertion.diff });
        return emitEvent(event);
      }),
    );

  const ask = Effect.fnUntraced(function* (assertion: Assertion, save: readonly PermissionRule[]) {
    const request = randomUUID();
    const deferred = yield* Deferred.make<Answer>();
    yield* Ref.update(pending, (map) => new Map(map).set(request, deferred));
    yield* emitRequest(request, assertion, save);
    yield* options.emit({
      ...agentStateTopic(ProcessState.Blocked),
      session: options.session,
    });
    // An interrupt unwinds the await like any other Effect, and the record
    // is written on the way out: a transcript must not keep a question that
    // can never be answered. No status follows it — the turn is ending, and
    // its own end frame says so.
    return yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() =>
        record(request, { decision: "reject", feedback: "interrupted" }, []),
      ),
      Effect.flatMap((decided) => settle(request, decided, save)),
    );
  });

  const settle = (
    request: string,
    decided: Answer,
    save: readonly PermissionRule[],
  ): Effect.Effect<void, string> =>
    record(request, decided, save).pipe(
      Effect.andThen(
        options.emit({
          ...agentStateTopic(ProcessState.Running),
          session: options.session,
        }),
      ),
      Effect.andThen(
        decided.decision === "reject" ? Effect.fail(refusal(decided.feedback)) : Effect.void,
      ),
    );

  const record = Effect.fnUntraced(function* (
    request: string,
    decided: Answer,
    save: readonly PermissionRule[],
  ) {
    yield* Ref.update(pending, (map) => {
      const next = new Map(map);
      next.delete(request);
      return next;
    });
    // Remembering before echoing: a client that sees "always" and asks the
    // same question again must find the rule already in force.
    if (decided.decision === "always" && save.length > 0) {
      yield* Ref.update(rules, (current) => [...current, ...save]);
      yield* options.store.addRules(save).pipe(Effect.ignore);
    }
    yield* emitEvent(
      decided.feedback === undefined
        ? {
            _tag: "permission.response",
            request,
            decision: decided.decision,
          }
        : {
            _tag: "permission.response",
            request,
            decision: decided.decision,
            feedback: decided.feedback,
          },
    );
  });

  return {
    assert: (assertion) =>
      Effect.gen(function* () {
        if (options.hooks) {
          const turn = yield* options.turn;
          const event =
            assertion.call !== undefined
              ? {
                  _tag: "tool_call" as const,
                  session: options.session,
                  turn,
                  tool: assertion.tool,
                  action: assertion.action,
                  resources: assertion.resources,
                  input: assertion.input,
                  call: assertion.call,
                }
              : {
                  _tag: "tool_call" as const,
                  session: options.session,
                  turn,
                  tool: assertion.tool,
                  action: assertion.action,
                  resources: assertion.resources,
                  input: assertion.input,
                };
          const hooked = yield* options.hooks.emitToolCall(event);
          if (hooked.block === true) return yield* Effect.fail(hooked.reason);
        }
        const current = yield* Ref.get(rules);
        const resourceEffect = evaluateAll(assertion.action, assertion.resources, current);
        const effect = resolvePermission(
          resourceEffect,
          assertion.tier,
          mode,
          toolApprovals[assertion.tool],
        );
        if (effect === "allow") return;
        if (effect === "ask") return yield* ask(assertion, savedRules(assertion));
        // A refusal is announced as a question that was already answered: an
        // agent that silently stops trying is a pane where nothing happened
        // for no visible reason.
        const request = randomUUID();
        yield* emitRequest(request, assertion, []);
        return yield* settle(request, { decision: "reject", feedback: "policy denies this" }, []);
      }),
    resolve: answer,
  } satisfies PermissionGate;
});

type Answer = { readonly decision: PermissionDecision; readonly feedback?: string };

const refusal = (feedback?: string) => `Denied by the user${feedback ? `: ${feedback}` : "."}`;

/**
 * What "always" would record for one assertion.
 *
 * A file action generalises to the whole project — `./**`, which matches every
 * resource `pathResource` produces for a file inside it and none of the absolute
 * ones it produces for a file outside — because approving one path at a time is
 * a prompt the user learns to answer without reading. A command generalises to
 * its leading words, so `git status --porcelain` becomes `git status *`: the
 * verb the user recognises, not the flags of one call. An opaque command
 * proposes nothing, see `bashResources`.
 */
export function savedRules(assertion: Assertion): readonly PermissionRule[] {
  if (assertion.action !== "bash")
    return [{ action: assertion.action, resource: "./**", effect: "allow" }];
  if (assertion.resources.some(isOpaque)) return [];
  return assertion.resources.map((segment) => ({
    action: "bash",
    resource: `${commandPrefix(segment)} *`,
    effect: "allow" as const,
  }));
}

/**
 * OMP bash-tool-runtime.md § interception: route shell misuse to a dedicated
 * tool when that tool is in the active toolkit. Not a sandbox — only a
 * ToolError naming the right tool. Cite ../oh-my-pi/docs/bash-tool-runtime.md
 * and packages/coding-agent/src/tools/bash-interceptor.ts.
 */
export interface BashInterceptorRule {
  readonly pattern: RegExp;
  readonly tool: string;
  readonly message: string;
}

/** Representative defaults: cat/head/tail → read, sed -i → edit, grep/rg → grep, find -name → glob. */
export const DEFAULT_BASH_INTERCEPTOR_RULES: readonly BashInterceptorRule[] = [
  {
    pattern: /^\s*(cat|head|tail|less|more)\s+/,
    tool: "read",
    message:
      "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
  },
  {
    pattern: /^\s*(grep|rg|ripgrep|ag|ack)\s+/,
    tool: "grep",
    message:
      "Use the `grep` tool instead of grep/rg. It respects .gitignore and provides structured output.",
  },
  {
    pattern: /^\s*(find|fd)\s+.*(-name|-iname|-type|--type|-glob)/,
    tool: "glob",
    message:
      "Use the `glob` tool instead of find/fd. It respects .gitignore and is faster for glob patterns.",
  },
  {
    pattern: /^\s*sed\s+(-i|--in-place)/,
    tool: "edit",
    message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
  },
];

/**
 * If the command is clearly a dedicated-tool job and that tool is available,
 * return a block message. Otherwise None. Checks the full command and each
 * bashResources segment (OMP also excludes piped-stdin fragments; we keep the
 * simpler segment split already owned here).
 */
export function checkBashInterception(
  command: string,
  availableTools: ReadonlySet<string> | readonly string[],
  rules: readonly BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
): Option.Option<{ readonly tool: string; readonly message: string }> {
  const tools = availableTools instanceof Set ? availableTools : new Set(availableTools);
  const candidates = [command.trim(), ...bashResources(command)];
  for (const rule of rules) {
    if (!tools.has(rule.tool)) continue;
    for (const candidate of candidates) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(candidate)) {
        return Option.some({
          tool: rule.tool,
          message: `Blocked: ${rule.message}\n\nOriginal command: ${command}`,
        });
      }
    }
  }
  return Option.none();
}

/**
 * The parts of a shell command that policy must clear, one at a time.
 *
 * A rule that allows `ls *` must not allow `ls; rm -rf ~`, so the command is
 * split on the operators that start a new command — `;`, `&&`, `||`, `|` and
 * newlines — with quotes and escapes respected, and every segment is judged.
 *
 * Substitutions and `eval` defeat this: what runs is not in the text. Those
 * segments are returned whole and marked opaque by `isOpaque`, which keeps them
 * permanently in "ask" — the honest answer, rather than a splitter that pretends
 * to understand them.
 */
export function bashResources(command: string): readonly string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let index = 0;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = "";
  };
  while (index < command.length) {
    const char = command[index]!;
    if (char === "\\" && quote !== "'") {
      current += char + (command[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      index += 1;
      continue;
    }
    if (char === ";" || char === "\n" || char === "&" || char === "|") {
      push();
      // && and || are two characters of one operator; & and | are one each.
      index += command[index + 1] === char ? 2 : 1;
      continue;
    }
    current += char;
    index += 1;
  }
  push();
  return segments;
}

/** A segment whose real command is not in its text, and never will be. */
export function isOpaque(segment: string): boolean {
  return (
    segment.includes("$(") ||
    segment.includes("`") ||
    segment.includes("<(") ||
    /(^|\s)eval(\s|$)/.test(segment)
  );
}

/**
 * The leading words of a command, up to the first argument that is not one.
 *
 * `git status --porcelain` is `git status`; `ls -la src` is `ls`. Flags and
 * paths belong to one call, subcommands to the thing the user is approving.
 */
function commandPrefix(segment: string): string {
  const words = segment.split(/\s+/).filter(Boolean);
  const prefix: string[] = [];
  for (const word of words) {
    if (prefix.length > 0 && !/^[a-z0-9][\w.-]*$/i.test(word)) break;
    prefix.push(word);
    if (prefix.length === 2) break;
  }
  return prefix.join(" ");
}

/**
 * How a path is named in a rule: `./` and the project-relative path when it is
 * inside the project, the absolute path when it is not.
 *
 * A rule recorded here must still hold in another worktree of the same
 * repository, which only relative paths do. The `./` is what makes "everywhere
 * in this project" expressible as a pattern: `./**` cannot match an absolute
 * path, so a project-wide approval never reaches outside the project.
 */
export const pathResource = Effect.fnUntraced(function* (root: string, path: string) {
  const pathService = yield* Path.Path;
  const inside = pathService.relative(root, path);
  return inside && !inside.startsWith("..") && !pathService.isAbsolute(inside)
    ? `./${inside}`
    : path;
});
