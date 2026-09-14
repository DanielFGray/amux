import {
  Prompt,
  type Chat,
  type LanguageModel,
  type Response,
  type Tool,
} from "effect/unstable/ai";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  Option,
  Queue,
  Ref,
  Scope,
  Schema as S,
  Stream,
} from "effect";
import type { AgentDelta, AgentEventPayload, JsonValue } from "@danielfgray/amux/protocol";
import { ProcessState } from "@danielfgray/amux";
import type { PromptDelivery, PromptInboxEntry } from "@danielfgray/amux/project-store.ts";
import { agentStateTopic } from "./state-topic.ts";
import { AGENT_AWARENESS_IDENTITY_TOPIC } from "@danielfgray/amux-agent-awareness/identity-state.ts";
import {
  emit as toAgentMessage,
  delta as toAgentDelta,
  decodeOpaqueJsonText,
  type HarnessDelta,
  type HarnessEvent,
} from "./protocol.ts";
import type { AgentToolkit } from "./tools.ts";
import { agentToolkitForChat } from "./tools.ts";
import {
  COMPACTION_TOPIC,
  DEFAULT_COMPACTION_STRATEGY,
  DEFAULT_KEEP_RECENT_TOKENS,
  compactChatHistory,
  type CompactionPolicy,
  type CompactOutcome,
} from "./compaction.ts";

/** Matches the provider id `agent-harness.tsx` registers this worker under
 *  (`spawnProviders.register(["native", ...])`) — the identity a turn's
 *  awareness report names itself as. */
const NATIVE_AGENT_IDENTITY = "native";

export type AgentWorker = {
  readonly prompt: (
    text: string,
    options?: {
      readonly id?: string;
      readonly delivery?: PromptDelivery;
      readonly resume?: boolean;
      /** Rewrite an existing queued admission (same turn id) instead of admitting a new one. */
      readonly replace?: string;
    },
  ) => Effect.Effect<void>;
  /** Schedule an existing durable admission after a worker restart. */
  readonly resume: (entry: PromptInboxEntry) => Effect.Effect<void>;
  readonly interrupt: (reason?: string) => Effect.Effect<void>;
  /**
   * Prefix-preserving compaction. Manual `/compact` passes `force: true`;
   * auto-compact after a turn uses the policy threshold.
   */
  readonly compact: (options?: {
    readonly instructions?: string;
    readonly force?: boolean;
  }) => Effect.Effect<CompactOutcome, never, LanguageModel.LanguageModel>;
  readonly close: Effect.Effect<void>;
};

export class AgentWorkerError extends S.TaggedError<AgentWorkerError>()("AgentWorkerError", {
  message: S.String,
}) {}

/** Keep provider diagnostics useful without allowing credentials or raw transport data into the UI. */
export function sanitizeAgentError(error: Error | string): string {
  const message = error instanceof Error ? error.message : String(error);
  // Stripping ANSI sequences means matching the ESC control character on purpose.
  // eslint-disable-next-line eslint/no-control-regex
  const normalized = message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").toLowerCase();
  // Keep the provider id — it is not a secret, and collapsing it into the
  // generic auth line made Codex-vs-OpenCode mixups undiagnosable in the UI.
  const missing = normalized.match(/credential missing for ([a-z0-9._-]+)/);
  if (missing) return `No credential for ${missing[1]}. Check Settings > auth.`;
  if (
    /credential|api key|api_key|unauthori[sz]ed|forbidden|authentication|401|403/.test(normalized)
  )
    return "Provider authentication failed. Check Settings > auth.";
  if (
    /model (?:not found|unavailable|invalid)|deployment|not found|404|invalid.*config|configuration/.test(
      normalized,
    )
  )
    return "Provider model configuration failed. Choose another model.";
  if (/network|timeout|timed out|connect|dns|fetch|rate limit|429|500|502|503|504/.test(normalized))
    return "Provider is unavailable. Check your network and try again.";
  return "The agent worker failed while processing the request.";
}

/** Repair calls a prior process could not finish before any provider sees the restored history. */
export const closeOpenToolCalls = (chat: Chat.Service) =>
  Ref.update(chat.history, (prompt) => {
    const answered = new Set<string>();
    const open = new Map<string, string>();
    for (const message of prompt.content) {
      if (message.role !== "assistant" && message.role !== "tool") continue;
      for (const part of message.content) {
        if (part.type === "tool-call") open.set(part.id, part.name);
        if (part.type === "tool-result") answered.add(part.id);
      }
    }
    for (const id of answered) open.delete(id);
    if (open.size === 0) return prompt;
    const results = [...open].map(([id, name]) =>
      Prompt.makePart("tool-result", {
        id,
        name,
        isFailure: true,
        result: "Tool execution interrupted",
        providerExecuted: false,
      }),
    );
    return Prompt.make([...prompt.content, Prompt.makeMessage("tool", { content: results })]);
  });

type QueuedTurn = {
  readonly turn: string;
  readonly prompt: string;
  readonly id?: string;
  readonly delivery: PromptDelivery;
};

/**
 * Project one provider stream part onto a durable harness event, if it is one.
 *
 * Reasoning and tool calls/results are events: the pane rebuilds its blocks by
 * folding the durable log, so they must survive a remount. Parts with no
 * transcript meaning (sources, finish metadata) and live-only fragments return
 * undefined here — see `harnessDeltaForPart`.
 */
export function harnessEventForPart(
  turn: string,
  part: Response.StreamPart<Record<string, Tool.Any>>,
): HarnessEvent | undefined {
  switch (part.type) {
    case "reasoning-delta":
      return { _tag: "reasoning.delta", turn, text: part.delta };
    case "tool-call": {
      const input = decodeOpaqueJsonText(part.params);
      if (Option.isNone(input)) return undefined;
      return {
        _tag: "tool.start",
        turn,
        call: part.id,
        tool: part.name,
        input: input.value,
      };
    }
    case "tool-result": {
      const output = decodeOpaqueJsonText(part.result);
      if (Option.isNone(output)) return undefined;
      return {
        _tag: "tool.result",
        turn,
        call: part.id,
        output: output.value,
        isError: part.isFailure,
      };
    }
    default:
      return undefined;
  }
}

/**
 * Project one provider stream part onto a live-only fragment, if it is one.
 *
 * Streamed text and partial tool arguments exist only to keep a pane moving;
 * a client that attaches later rebuilds from the durable log instead.
 */
export function harnessDeltaForPart(
  turn: string,
  part: Response.StreamPart<Record<string, Tool.Any>>,
): HarnessDelta | undefined {
  switch (part.type) {
    case "text-delta":
      return { _tag: "text.delta", turn, text: part.delta };
    case "tool-params-start":
      return { _tag: "tool.params-start", turn, call: part.id, tool: part.name };
    case "tool-params-delta":
      return { _tag: "tool.params-delta", turn, call: part.id, delta: part.delta };
    case "tool-params-end":
      return { _tag: "tool.params-end", turn, call: part.id };
    default:
      return undefined;
  }
}

/**
 * Run one native-agent session.
 *
 * The conversation lives in the injected `Chat`, so history, tool-call/result
 * pairing and provider message construction all belong to `@effect/ai`. What is
 * ours is the scheduler above it: a mailbox, one turn at a time, and
 * interruption that leaves the transcript intact.
 */
export function makeAgentWorker<E = never>(options: {
  readonly session: string;
  readonly chat: Chat.Service;
  readonly emit: (frame: AgentEventPayload | AgentDelta) => Effect.Effect<void>;
  /**
   * Handlers already installed (`AgentToolkit`). Prefer this over
   * `Toolkit.WithHandler<Record<string, Tool.Any>>`, which puts `any` in R via
   * `Tool.HandlerServices`.
   */
  readonly toolkit?: Effect.Effect<AgentToolkit>;
  /** Commit the provider-valid history only after a provider step has settled. */
  readonly persist?: Effect.Effect<void>;
  /** Fire when a turn actually begins executing, not when it is queued. */
  readonly onTurnStart?: (turn: string) => Effect.Effect<void>;
  /**
   * After a tool result is emitted. Used for prewalk handoff on the first
   * successful mutating tool; optional so unit tests stay free of model policy.
   */
  readonly onToolResult?: (tool: string, succeeded: boolean) => Effect.Effect<void>;
  /**
   * Compaction policy from harness options + catalog context limit.
   * Absent → manual compact still works with keepRecent defaults; auto never fires.
   */
  readonly compaction?: CompactionPolicy;
  /** Durable admission store. The worker remains the executor, never the authority. */
  readonly inbox?: {
    readonly admitPrompt: (
      session: string,
      prompt: string,
      delivery: PromptDelivery,
      resume?: boolean,
      id?: string,
    ) => Effect.Effect<PromptInboxEntry, E>;
    readonly pendingPrompts: (session: string) => Effect.Effect<readonly PromptInboxEntry[], E>;
    readonly promotePrompt: (id: string) => Effect.Effect<void, E>;
    readonly updatePendingPrompt: (
      id: string,
      patch: { readonly prompt?: string; readonly delivery?: PromptDelivery },
    ) => Effect.Effect<PromptInboxEntry, E>;
  };
}): Effect.Effect<AgentWorker, never, Scope.Scope | LanguageModel.LanguageModel> {
  return Effect.gen(function* () {
    const inbox = yield* Ref.make<readonly QueuedTurn[]>([]);
    const wake = yield* Queue.unbounded<void>();
    const turns = yield* Ref.make(0);
    const running = yield* FiberHandle.make<void, never>();

    const emitEvent = (event: HarnessEvent) => options.emit(toAgentMessage(options.session, event));
    const emitDelta = (fragment: HarnessDelta) =>
      options.emit(toAgentDelta(options.session, fragment));
    /** A worker-observed topic isn't harness vocabulary — it rides `agent.emit`'s
     *  `topic` variant directly, with `session` filled in here. */
    const emitTopic = (frame: {
      readonly _tag: "topic";
      readonly topic: string;
      readonly payload: JsonValue;
    }) => options.emit({ ...frame, session: options.session } as AgentEventPayload);

    /**
     * Pair every tool call the history left open with a cancelled result.
     *
     * The provider contract is that each tool call is answered exactly once.
     * Interrupting a turn while a handler is still running satisfies neither
     * the caller nor the provider, so the worker answers on the tool's behalf
     * and the transcript stays a valid prompt for the next turn.
     */
    const repairOpenToolCalls = closeOpenToolCalls(options.chat);

    const policy: CompactionPolicy = options.compaction ?? {
      auto: false,
      atPercent: 85,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
      strategy: DEFAULT_COMPACTION_STRATEGY,
    };

    const runCompact = (opts?: {
      readonly instructions?: string;
      readonly force?: boolean;
    }): Effect.Effect<CompactOutcome, never, LanguageModel.LanguageModel> =>
      compactChatHistory({
        history: options.chat.history,
        policy,
        instructions: opts?.instructions,
        force: opts?.force,
      }).pipe(
        Effect.tap((outcome) =>
          outcome._tag === "compacted"
            ? emitTopic({
                _tag: "topic",
                topic: COMPACTION_TOPIC,
                payload: {
                  tokensBefore: outcome.tokensBefore,
                  tokensAfter: outcome.tokensAfter,
                  summarized: outcome.summarizedMessages,
                  kept: outcome.keptMessages,
                  strategy: outcome.strategy,
                  manual: opts?.force === true,
                },
              }).pipe(Effect.andThen(options.persist ?? Effect.void))
            : Effect.void,
        ),
      );

    /**
     * Terminal frames for every exit, so no path leaves the pane mid-turn.
     *
     * A failure carries its cause: the turn is the only place the error is ever
     * reported, because runTurn absorbs it afterwards. Dropping it here makes a
     * provider rejecting the request indistinguishable from an empty answer.
     */
    const settle = (
      turn: string,
      exit: Exit.Exit<void, unknown>,
      text: string,
    ): Effect.Effect<void, never, LanguageModel.LanguageModel> => {
      const outcome = Exit.isSuccess(exit)
        ? ("completed" as const)
        : Cause.hasInterruptsOnly(exit.cause)
          ? ("interrupted" as const)
          : ("failed" as const);
      // A turn cut short between a tool call and its result leaves the call
      // unpaired, and a provider rejects that history outright — so the session
      // would be dead from the next prompt on, not just this turn.
      const repair = outcome === "completed" ? Effect.void : repairOpenToolCalls;
      const error =
        Exit.isFailure(exit) && outcome === "failed"
          ? sanitizeAgentError(Cause.pretty(exit.cause))
          : undefined;
      const turnEnd = { _tag: "turn.end" as const, turn, outcome };
      if (text) Object.assign(turnEnd, { text });
      if (error) Object.assign(turnEnd, { error });
      return repair.pipe(
        Effect.andThen(emitEvent(turnEnd)),
        // The process itself is idle either way — a failed turn does not exit
        // it, so SESSION_STATE_TOPIC (core's neutral ProcessState) can only
        // ever say `idle` here. `turnEnd` above already carries the failure
        // (`outcome: "failed"` + `error`) as a durable plugin-owned fact; this
        // second report rides the same awareness-owned topic the opencode
        // hook uses, so a live (non-exited) failure still reaches the
        // sidebar/tab glyph the way `turnEnd` alone cannot.
        Effect.andThen(emitTopic(agentStateTopic(ProcessState.Idle))),
        Effect.andThen(
          emitTopic({
            _tag: "topic",
            topic: AGENT_AWARENESS_IDENTITY_TOPIC,
            payload: {
              agent: NATIVE_AGENT_IDENTITY,
              state: outcome === "failed" ? "failed" : "idle",
            },
          }),
        ),
        // Auto-compact after a successful turn when the gauge says so.
        // Manual /compact uses force:true and skips the threshold.
        Effect.andThen(
          outcome === "completed" ? runCompact({ force: false }).pipe(Effect.asVoid) : Effect.void,
        ),
      );
    };

    // Total by construction: the catchAll below absorbs every typed failure
    // after settle has reported it, which is what lets a turn fail without
    // ending the session and what FiberHandle<void, never> requires.
    const takeSteer = Ref.modify(inbox, (pending) => {
      const index = pending.findIndex((item) => item.delivery === "steer");
      if (index < 0) return [Option.none<QueuedTurn>(), pending] as const;
      return [
        Option.some(pending[index]!),
        [...pending.slice(0, index), ...pending.slice(index + 1)],
      ] as const;
    });

    const runTurn = (
      queued: QueuedTurn,
    ): Effect.Effect<void, never, LanguageModel.LanguageModel> => {
      const { turn, prompt } = queued;
      let responseText = "";
      const openToolNames = new Map<string, string>();
      const runStep = (
        stepPrompt: string | Prompt.Prompt,
      ): Effect.Effect<void, AgentWorkerError, LanguageModel.LanguageModel> => {
        let needsContinuation = false;
        const stream = options.toolkit
          ? options.chat.streamText({
              prompt: stepPrompt,
              toolkit: agentToolkitForChat(options.toolkit),
            })
          : options.chat.streamText({ prompt: stepPrompt });
        // Chat.streamText's ToolkitInput defaults `R = any` for open tool maps;
        // handlers are already installed on AgentToolkit (stream R=never).
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        return stream.pipe(
          Stream.runForEach((rawPart) => {
            const part = rawPart as Response.StreamPart<Record<string, Tool.Any>>;
            const event = harnessEventForPart(turn, part);
            if (event) {
              if (event._tag === "tool.start") {
                needsContinuation = true;
                openToolNames.set(event.call, event.tool);
              }
              const after =
                event._tag === "tool.result"
                  ? (() => {
                      const tool = openToolNames.get(event.call) ?? "";
                      openToolNames.delete(event.call);
                      return options.onToolResult?.(tool, event.isError !== true) ?? Effect.void;
                    })()
                  : Effect.void;
              return emitEvent(event).pipe(Effect.andThen(after));
            }
            const fragment = harnessDeltaForPart(turn, part);
            if (fragment) {
              if (fragment._tag === "text.delta") responseText += fragment.text;
              return emitDelta(fragment);
            }
            return Effect.void;
          }),
          // Chat commits its response when stream consumption releases.
          // Checkpoint afterwards, or recovery misses the just-finished step.
          Effect.andThen(options.persist ?? Effect.void),
          // A steer is an instruction for the next provider boundary, not a
          // FIFO turn. Check before tool continuation so it can redirect the
          // agent before the provider sees the tool result again.
          Effect.flatMap(() =>
            needsContinuation
              ? takeSteer.pipe(
                  Effect.flatMap((steer) =>
                    Option.match(steer, {
                      onNone: () => runStep(Prompt.empty),
                      onSome: (turn) => runTurn(turn),
                    }),
                  ),
                )
              : Effect.void,
          ),
          // Keep the provider's own message: settle() runs it through
          // sanitizeAgentError, which needs the real text (401, rate limit,
          // unknown model, …) to pick the right category instead of the
          // generic fallback.
          Effect.mapError((error) => new AgentWorkerError({ message: String(error) })),
        );
      };
      return (
        // A steer can start inside an active turn rather than from drain's
        // normal dequeue. Remove it here too, so its original wake cannot run
        // the same durable entry after the nested turn settles.
        Ref.update(inbox, (pending) => pending.filter((entry) => entry.turn !== queued.turn)).pipe(
          Effect.andThen(
            queued.id && options.inbox
              ? options.inbox
                  .promotePrompt(queued.id)
                  .pipe(
                    Effect.mapError(
                      () => new AgentWorkerError({ message: "prompt promotion failed" }),
                    ),
                  )
              : Effect.void,
          ),
          Effect.andThen(emitEvent({ _tag: "turn.start", turn, prompt })),
          Effect.andThen(options.onTurnStart?.(turn) ?? Effect.void),
          Effect.andThen(emitTopic(agentStateTopic(ProcessState.Running))),
          Effect.andThen(runStep(prompt)),
          Effect.onExit((exit) => settle(turn, exit, responseText)),
          // settle has already reported the failure as turn.end{failed}, so the
          // transcript is this turn's error channel and there is nothing left to
          // raise. A provider 500 ends a turn, never the session. catchAll takes
          // only typed failures: interruption still unwinds, defects still crash.
          Effect.ignore,
        )
      );
    };

    // One turn at a time: a prompt that lands mid-turn queues the next prompt
    // rather than racing the running one. An interrupted turn must not end the
    // session, so the join failure is absorbed here.
    const next = Ref.modify(inbox, (pending) => {
      const index = pending.findIndex((item) => item.delivery === "steer");
      const selected = index < 0 ? pending[0] : pending[index];
      if (selected === undefined) return [Option.none<QueuedTurn>(), pending] as const;
      return [
        Option.some(selected),
        [...pending.slice(0, index < 0 ? 1 : index), ...pending.slice(index + 1)],
      ] as const;
    });
    const drain = Effect.forever(
      Queue.take(wake).pipe(
        Effect.andThen(next),
        Effect.flatMap((queued) =>
          Option.match(queued, {
            onNone: () => Effect.void,
            onSome: (turn) =>
              FiberHandle.run(running, runTurn(turn)).pipe(
                Effect.flatMap(Fiber.join),
                Effect.ignoreCause,
              ),
          }),
        ),
      ),
    );
    const drainFiber = yield* Effect.forkScoped(drain);

    const admit = (
      text: string,
      promptOptions: {
        readonly id?: string;
        readonly delivery?: PromptDelivery;
        readonly resume?: boolean;
      } = {},
    ): Effect.Effect<void> => {
      const admission: Effect.Effect<Option.Option<PromptInboxEntry>> = options.inbox
        ? options.inbox
            .admitPrompt(
              options.session,
              text,
              promptOptions.delivery ?? "queue",
              promptOptions.resume,
              promptOptions.id,
            )
            .pipe(
              Effect.mapError(() => new AgentWorkerError({ message: "prompt admission failed" })),
              Effect.map(Option.some),
              Effect.orElseSucceed(Option.none),
            )
        : Effect.succeed(Option.none());
      return admission.pipe(
        Effect.flatMap((admitted) =>
          Ref.updateAndGet(turns, (n) => n + 1).pipe(
            Effect.flatMap((n) => {
              const turn = Option.match(admitted, {
                onNone: () => `turn-${n}`,
                onSome: (entry) => entry.turn,
              });
              const queued = {
                turn,
                prompt: text,
                delivery: promptOptions.delivery ?? "queue",
                ...Option.match(admitted, {
                  onNone: () => ({}),
                  onSome: (entry) => ({ id: entry.id }),
                }),
              } satisfies QueuedTurn;
              return emitEvent({
                _tag: "turn.queued",
                turn,
                prompt: text,
                delivery: promptOptions.delivery ?? "queue",
              }).pipe(
                Effect.andThen(
                  promptOptions.resume === false
                    ? Effect.void
                    : Ref.update(inbox, (pending) => [...pending, queued]),
                ),
                Effect.andThen(
                  promptOptions.resume === false ? Effect.void : Queue.offer(wake, undefined),
                ),
                Effect.asVoid,
              );
            }),
          ),
        ),
      );
    };

    return {
      prompt: (text, promptOptions = {}) => {
        const replaceTurn = promptOptions.replace;
        if (!replaceTurn) return admit(text, promptOptions);

        const delivery = promptOptions.delivery;
        return Ref.modify(inbox, (pending) => {
          const index = pending.findIndex((entry) => entry.turn === replaceTurn);
          if (index < 0) return [Option.none<QueuedTurn>(), pending] as const;
          const previous = pending[index]!;
          const next = {
            ...previous,
            prompt: text,
            delivery: delivery ?? previous.delivery,
          } satisfies QueuedTurn;
          return [
            Option.some(next),
            [...pending.slice(0, index), next, ...pending.slice(index + 1)],
          ] as const;
        }).pipe(
          Effect.flatMap((updated) =>
            Option.match(updated, {
              onNone: () => {
                const { replace: _omit, ...rest } = promptOptions;
                return admit(text, rest);
              },
              onSome: (entry) => {
                const persist =
                  entry.id !== undefined && options.inbox
                    ? options.inbox
                        .updatePendingPrompt(
                          entry.id,
                          delivery !== undefined ? { prompt: text, delivery } : { prompt: text },
                        )
                        .pipe(
                          Effect.mapError(
                            () => new AgentWorkerError({ message: "prompt update failed" }),
                          ),
                          Effect.ignore,
                        )
                    : Effect.void;
                return persist.pipe(
                  Effect.andThen(
                    emitEvent({
                      _tag: "turn.queued",
                      turn: entry.turn,
                      prompt: text,
                      delivery: entry.delivery,
                    }),
                  ),
                  // Steer is checked at the next provider boundary; offering wake
                  // is harmless and covers an idle session whose only pending
                  // work just flipped from queue to steer.
                  Effect.andThen(Queue.offer(wake, undefined)),
                  Effect.asVoid,
                );
              },
            }),
          ),
        );
      },
      resume: (entry) =>
        Ref.update(inbox, (pending) => [
          ...pending,
          { turn: entry.turn, prompt: entry.prompt, id: entry.id, delivery: entry.delivery },
        ]).pipe(Effect.andThen(Queue.offer(wake, undefined)), Effect.asVoid),
      // Interruption is Effect's, so the provider request, the stream and every
      // finalizer unwind together; there is no abort flag to keep in sync.
      interrupt: () => FiberHandle.clear(running),
      compact: (compactOptions) =>
        runCompact({
          instructions: compactOptions?.instructions,
          force: compactOptions?.force ?? true,
        }),
      close: Fiber.interrupt(drainFiber).pipe(Effect.asVoid),
    } satisfies AgentWorker;
  });
}
