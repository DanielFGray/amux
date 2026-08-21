import {
  Prompt,
  type Chat,
  type LanguageModel,
  type Response,
  type Tool,
  type Toolkit,
} from "@effect/ai";
import { Cause, Effect, Exit, Fiber, FiberHandle, Queue, Ref, Scope, Stream } from "effect";
import type { AgentEventPayload, AgentDelta } from "../../../effect/AttachProtocol.ts";
import { AgentState } from "../../../agent-state.ts";
import type { PromptDelivery, PromptInboxEntry } from "../../../project-store.ts";

export type AgentWorker = {
  readonly prompt: (
    text: string,
    options?: {
      readonly id?: string;
      readonly delivery?: PromptDelivery;
      readonly resume?: boolean;
    },
  ) => Effect.Effect<void>;
  /** Schedule an existing durable admission after a worker restart. */
  readonly resume: (entry: PromptInboxEntry) => Effect.Effect<void>;
  readonly interrupt: (reason?: string) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
};

/** Keep provider diagnostics useful without allowing credentials or raw transport data into the UI. */
export function sanitizeAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Stripping ANSI sequences means matching the ESC control character on purpose.
  // eslint-disable-next-line eslint/no-control-regex
  const normalized = message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").toLowerCase();
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

/**
 * What the worker hands to `emit`: any agent frame except the `session` field,
 * which `emit` supplies because the worker runs one session and cannot name
 * another. Derived from the protocol rather than restated, so a frame added to
 * the wire is emittable here without a second edit that can be forgotten.
 */
type AgentFramePayload = WithoutSession<AgentEventPayload | AgentDelta>;
type WithoutSession<Frame> = Frame extends unknown ? Omit<Frame, "session"> : never;

type QueuedTurn = {
  readonly turn: string;
  readonly prompt: string;
  readonly id?: string;
  readonly delivery: PromptDelivery;
};

/**
 * Project one provider stream part onto the wire frame the mux already speaks.
 *
 * Parts with no transcript meaning (sources, finish metadata) return undefined.
 */
export function frameForPart(
  turn: string,
  part: Response.StreamPart<Record<string, Tool.Any>>,
): AgentFramePayload | undefined {
  switch (part.type) {
    case "text-delta":
      return { _tag: "text.delta", turn, text: part.delta };
    case "reasoning-delta":
      return { _tag: "reasoning.delta", turn, text: part.delta };
    case "tool-params-start":
      return {
        _tag: "tool.params-start",
        turn,
        call: part.id,
        tool: part.name,
      };
    case "tool-params-delta":
      return {
        _tag: "tool.params-delta",
        turn,
        call: part.id,
        delta: part.delta,
      };
    case "tool-params-end":
      return { _tag: "tool.params-end", turn, call: part.id };
    case "tool-call":
      return {
        _tag: "tool.start",
        turn,
        call: part.id,
        tool: part.name,
        input: part.params,
      };
    case "tool-result":
      return {
        _tag: "tool.result",
        turn,
        call: part.id,
        output: part.result,
        isError: part.isFailure,
      };
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
export function makeAgentWorker<Tools extends Record<string, Tool.Any>>(options: {
  readonly session: string;
  readonly chat: Chat.Service;
  readonly emit: (frame: AgentEventPayload | AgentDelta) => Effect.Effect<void>;
  readonly toolkit?: Effect.Effect<Toolkit.WithHandler<Tools>>;
  /** Commit the provider-valid history only after a provider step has settled. */
  readonly persist?: Effect.Effect<void>;
  /** Fire when a turn actually begins executing, not when it is queued. */
  readonly onTurnStart?: (turn: string) => Effect.Effect<void>;
  /** Durable admission store. The worker remains the executor, never the authority. */
  readonly inbox?: {
    readonly admitPrompt: (
      session: string,
      prompt: string,
      delivery: PromptDelivery,
      resume?: boolean,
      id?: string,
    ) => Effect.Effect<PromptInboxEntry, unknown>;
    readonly pendingPrompts: (
      session: string,
    ) => Effect.Effect<readonly PromptInboxEntry[], unknown>;
    readonly promotePrompt: (id: string) => Effect.Effect<void, unknown>;
  };
}): Effect.Effect<
  AgentWorker,
  never,
  Scope.Scope | LanguageModel.LanguageModel | Tool.Requirements<Tools[keyof Tools]>
> {
  return Effect.gen(function* () {
    const inbox = yield* Ref.make<readonly QueuedTurn[]>([]);
    const wake = yield* Queue.unbounded<void>();
    const turns = yield* Ref.make(0);
    const running = yield* FiberHandle.make<void, never>();

    const emit = (frame: AgentFramePayload) =>
      options.emit({ ...frame, session: options.session } as AgentEventPayload | AgentDelta);

    /**
     * Pair every tool call the history left open with a cancelled result.
     *
     * The provider contract is that each tool call is answered exactly once.
     * Interrupting a turn while a handler is still running satisfies neither
     * the caller nor the provider, so the worker answers on the tool's behalf
     * and the transcript stays a valid prompt for the next turn.
     */
    const repairOpenToolCalls = closeOpenToolCalls(options.chat);

    /**
     * Terminal frames for every exit, so no path leaves the pane mid-turn.
     *
     * A failure carries its cause: the turn is the only place the error is ever
     * reported, because runTurn absorbs it afterwards. Dropping it here makes a
     * provider rejecting the request indistinguishable from an empty answer.
     */
    const settle = (turn: string, exit: Exit.Exit<void, unknown>, text: string) => {
      const outcome = Exit.isSuccess(exit)
        ? ("completed" as const)
        : Cause.isInterruptedOnly(exit.cause)
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
      return repair.pipe(
        Effect.andThen(
          emit({
            _tag: "turn.end",
            turn,
            outcome,
            ...(text ? { text } : {}),
            ...(error ? { error } : {}),
          }),
        ),
        Effect.andThen(
          emit({
            _tag: "agent.status",
            state: outcome === "failed" ? AgentState.Failed : AgentState.Idle,
          }),
        ),
      );
    };

    // Total by construction: the catchAll below absorbs every typed failure
    // after settle has reported it, which is what lets a turn fail without
    // ending the session and what FiberHandle<void, never> requires.
    const takeSteer = Ref.modify(inbox, (pending) => {
      const index = pending.findIndex((item) => item.delivery === "steer");
      if (index < 0) return [undefined, pending] as const;
      return [pending[index], [...pending.slice(0, index), ...pending.slice(index + 1)]] as const;
    });

    const runTurn = (
      queued: QueuedTurn,
    ): Effect.Effect<
      void,
      never,
      LanguageModel.LanguageModel | Tool.Requirements<Tools[keyof Tools]>
    > => {
      const { turn, prompt } = queued;
      let responseText = "";
      const runStep = (
        stepPrompt: string | Prompt.Prompt,
      ): Effect.Effect<
        void,
        unknown,
        LanguageModel.LanguageModel | Tool.Requirements<Tools[keyof Tools]>
      > => {
        let needsContinuation = false;
        return options.chat
          .streamText(
            options.toolkit
              ? { prompt: stepPrompt, toolkit: options.toolkit }
              : { prompt: stepPrompt },
          )
          .pipe(
            Stream.runForEach((part) => {
              const frame = frameForPart(
                turn,
                part as Response.StreamPart<Record<string, Tool.Any>>,
              );
              if (frame?._tag === "text.delta") responseText += frame.text;
              if (frame?._tag === "tool.start") needsContinuation = true;
              return frame ? emit(frame) : Effect.void;
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
                    Effect.flatMap((steer) => (steer ? runTurn(steer) : runStep(Prompt.empty))),
                  )
                : Effect.void,
            ),
          );
      };
      return (
        // A steer can start inside an active turn rather than from drain's
        // normal dequeue. Remove it here too, so its original wake cannot run
        // the same durable entry after the nested turn settles.
        Ref.update(inbox, (pending) => pending.filter((entry) => entry.turn !== queued.turn)).pipe(
          Effect.andThen(
            queued.id && options.inbox ? options.inbox.promotePrompt(queued.id) : Effect.void,
          ),
          Effect.andThen(emit({ _tag: "turn.start", turn, prompt })),
          Effect.andThen(options.onTurnStart?.(turn) ?? Effect.void),
          Effect.andThen(emit({ _tag: "agent.status", state: AgentState.Working })),
          Effect.andThen(runStep(prompt)),
          Effect.onExit((exit) => settle(turn, exit, responseText)),
          // settle has already reported the failure as turn.end{failed}, so the
          // transcript is this turn's error channel and there is nothing left to
          // raise. A provider 500 ends a turn, never the session. catchAll takes
          // only typed failures: interruption still unwinds, defects still crash.
          Effect.catchAll(() => Effect.void),
        )
      );
    };

    // One turn at a time: a prompt that lands mid-turn queues the next prompt
    // rather than racing the running one. An interrupted turn must not end the
    // session, so the join failure is absorbed here.
    const next = Ref.modify(inbox, (pending) => {
      const index = pending.findIndex((item) => item.delivery === "steer");
      const selected = index < 0 ? pending[0] : pending[index];
      if (!selected) return [undefined, pending] as const;
      return [
        selected,
        [...pending.slice(0, index < 0 ? 1 : index), ...pending.slice(index + 1)],
      ] as const;
    });
    const drain = Effect.forever(
      Queue.take(wake).pipe(
        Effect.andThen(next),
        Effect.flatMap((queued) =>
          queued
            ? FiberHandle.run(running, runTurn(queued)).pipe(
                Effect.flatMap(Fiber.join),
                Effect.catchAllCause(() => Effect.void),
              )
            : Effect.void,
        ),
      ),
    );
    const drainFiber = yield* Effect.forkScoped(drain);

    return {
      prompt: (text, promptOptions = {}) => {
        const admission: Effect.Effect<PromptInboxEntry | undefined> = options.inbox
          ? options.inbox
              .admitPrompt(
                options.session,
                text,
                promptOptions.delivery ?? "queue",
                promptOptions.resume,
                promptOptions.id,
              )
              .pipe(Effect.orDie)
          : Effect.void.pipe(Effect.as<PromptInboxEntry | undefined>(undefined));
        return admission.pipe(
          Effect.flatMap((admitted) =>
            Ref.updateAndGet(turns, (n) => n + 1).pipe(
              Effect.flatMap((n) => {
                const turn = admitted?.turn ?? `turn-${n}`;
                const queued = {
                  turn,
                  prompt: text,
                  delivery: promptOptions.delivery ?? "queue",
                  ...(admitted ? { id: admitted.id } : {}),
                } satisfies QueuedTurn;
                return emit({
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
      },
      resume: (entry) =>
        Ref.update(inbox, (pending) => [
          ...pending,
          { turn: entry.turn, prompt: entry.prompt, id: entry.id, delivery: entry.delivery },
        ]).pipe(Effect.andThen(Queue.offer(wake, undefined)), Effect.asVoid),
      // Interruption is Effect's, so the provider request, the stream and every
      // finalizer unwind together; there is no abort flag to keep in sync.
      interrupt: () => FiberHandle.clear(running),
      close: Fiber.interrupt(drainFiber).pipe(Effect.asVoid),
    } satisfies AgentWorker;
  });
}
