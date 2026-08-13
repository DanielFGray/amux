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

export type AgentWorker = {
  readonly prompt: (text: string) => Effect.Effect<void>;
  readonly interrupt: (reason?: string) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
};

/** Keep provider diagnostics useful without allowing credentials or raw transport data into the UI. */
export function sanitizeAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
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
}): Effect.Effect<
  AgentWorker,
  never,
  Scope.Scope | LanguageModel.LanguageModel | Tool.Requirements<Tools[keyof Tools]>
> {
  return Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<QueuedTurn>();
    const turns = yield* Ref.make(0);
    const running = yield* FiberHandle.make<void, never>();

    const emit = (frame: AgentFramePayload) =>
      options.emit({ ...frame, session: options.session } as AgentEventPayload | AgentDelta);

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
      const error =
        Exit.isFailure(exit) && outcome === "failed"
          ? sanitizeAgentError(Cause.pretty(exit.cause))
          : undefined;
      return emit({
        _tag: "turn.end",
        turn,
        outcome,
        ...(text ? { text } : {}),
        ...(error ? { error } : {}),
      }).pipe(
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
            Effect.flatMap(() => (needsContinuation ? runStep(Prompt.empty) : Effect.void)),
          );
      };
      return (options.onTurnStart?.(turn) ?? Effect.void).pipe(
        Effect.andThen(emit({ _tag: "agent.status", state: AgentState.Working })),
        Effect.andThen(runStep(prompt)),
        Effect.onExit((exit) => settle(turn, exit, responseText)),
        // settle has already reported the failure as turn.end{failed}, so the
        // transcript is this turn's error channel and there is nothing left to
        // raise. A provider 500 ends a turn, never the session. catchAll takes
        // only typed failures: interruption still unwinds, defects still crash.
        Effect.catchAll(() => Effect.void),
      );
    };

    // One turn at a time: a prompt that lands mid-turn queues the next prompt
    // rather than racing the running one. An interrupted turn must not end the
    // session, so the join failure is absorbed here.
    const drain = Effect.forever(
      Queue.take(inbox).pipe(
        Effect.flatMap((queued) =>
          FiberHandle.run(running, runTurn(queued)).pipe(
            Effect.flatMap(Fiber.join),
            Effect.catchAllCause(() => Effect.void),
          ),
        ),
      ),
    );
    const drainFiber = yield* Effect.forkScoped(drain);

    return {
      // `turn.start` is emitted here, at enqueue time, so the transcript shows
      // the user's message the moment it is submitted — even while an earlier
      // turn is still running. The queued turn keeps its turn id, so the later
      // Working/end frames attach to the prompt the user already saw.
      prompt: (text) =>
        Ref.updateAndGet(turns, (n) => n + 1).pipe(
          Effect.flatMap((n) => {
            const turn = `turn-${n}`;
            return emit({ _tag: "turn.start", turn, prompt: text }).pipe(
              Effect.andThen(Queue.offer(inbox, { turn, prompt: text })),
              Effect.asVoid,
            );
          }),
        ),
      // Interruption is Effect's, so the provider request, the stream and every
      // finalizer unwind together; there is no abort flag to keep in sync.
      interrupt: () => FiberHandle.clear(running),
      close: Fiber.interrupt(drainFiber).pipe(Effect.asVoid),
    } satisfies AgentWorker;
  });
}
