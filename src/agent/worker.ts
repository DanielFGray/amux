import type { Chat, LanguageModel, Response, Tool, Toolkit } from "@effect/ai";
import { Cause, Effect, Exit, Fiber, FiberHandle, Queue, Ref, Scope, Stream } from "effect";
import type { AgentEventPayload, AgentDelta } from "../effect/AttachProtocol.ts";
import type { ReportedAgentState } from "../agent-state.ts";

export type AgentWorker = {
  readonly steer: (message: string) => Effect.Effect<void>;
  readonly interrupt: (reason?: string) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
};

type AgentFramePayload =
  | {
      readonly _tag: "agent.status";
      readonly state: ReportedAgentState;
    }
  | { readonly _tag: "turn.start"; readonly turn: string; readonly prompt: string }
  | { readonly _tag: "text.delta"; readonly turn: string; readonly text: string }
  | {
      readonly _tag: "tool.params-start";
      readonly turn: string;
      readonly call: string;
      readonly tool: string;
    }
  | {
      readonly _tag: "tool.params-delta";
      readonly turn: string;
      readonly call: string;
      readonly delta: string;
    }
  | {
      readonly _tag: "tool.params-end";
      readonly turn: string;
      readonly call: string;
    }
  | {
      readonly _tag: "tool.start";
      readonly turn: string;
      readonly call: string;
      readonly tool: string;
      readonly input: unknown;
    }
  | {
      readonly _tag: "tool.result";
      readonly turn: string;
      readonly call: string;
      readonly output: unknown;
      readonly isError: boolean;
    }
  | {
      readonly _tag: "turn.end";
      readonly turn: string;
      readonly outcome: "completed" | "interrupted" | "failed";
      readonly text?: string;
    };

/**
 * Project one provider stream part onto the wire frame the mux already speaks.
 *
 * Parts with no transcript meaning (reasoning, sources, finish metadata) return
 * undefined rather than being forced into a frame.
 */
export function frameForPart(
  turn: string,
  part: Response.StreamPart<Record<string, Tool.Any>>,
  toolName: (name: string) => string,
): AgentFramePayload | undefined {
  switch (part.type) {
    case "text-delta":
      return { _tag: "text.delta", turn, text: part.delta };
    case "tool-params-start":
      return { _tag: "tool.params-start", turn, call: part.id, tool: toolName(part.name) };
    case "tool-params-delta":
      return { _tag: "tool.params-delta", turn, call: part.id, delta: part.delta };
    case "tool-params-end":
      return { _tag: "tool.params-end", turn, call: part.id };
    case "tool-call":
      return {
        _tag: "tool.start",
        turn,
        call: part.id,
        tool: toolName(part.name),
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
  /** Provider-safe tool names map back to command tags for the transcript. */
  readonly toolName?: (name: string) => string;
}): Effect.Effect<
  AgentWorker,
  never,
  Scope.Scope | LanguageModel.LanguageModel | Tool.Requirements<Tools[keyof Tools]>
> {
  return Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<string>();
    const turns = yield* Ref.make(0);
    const running = yield* FiberHandle.make<void, never>();
    const toolName = options.toolName ?? ((name: string) => name);

    const emit = (frame: AgentFramePayload) =>
      options.emit({ ...frame, session: options.session } as AgentEventPayload | AgentDelta);

    /** Terminal frames for every exit, so no path leaves the pane mid-turn. */
    const settle = (turn: string, exit: Exit.Exit<void, unknown>, text: string) => {
      const outcome = Exit.isSuccess(exit)
        ? ("completed" as const)
        : Cause.isInterruptedOnly(exit.cause)
          ? ("interrupted" as const)
          : ("failed" as const);
      return emit({ _tag: "turn.end", turn, outcome, ...(text ? { text } : {}) }).pipe(
        Effect.andThen(
          emit({ _tag: "agent.status", state: outcome === "failed" ? "failed" : "idle" }),
        ),
      );
    };

    const runTurn = (prompt: string) =>
      Ref.updateAndGet(turns, (n) => n + 1).pipe(
        Effect.flatMap((n) => {
          const turn = `turn-${n}`;
          let responseText = "";
          return emit({ _tag: "agent.status", state: "working" }).pipe(
            Effect.andThen(emit({ _tag: "turn.start", turn, prompt })),
            Effect.andThen(
              options.chat
                .streamText(
                  options.toolkit ? { prompt, toolkit: options.toolkit } : { prompt },
                )
                .pipe(
                  Stream.runForEach((part) => {
                    const frame = frameForPart(
                      turn,
                      part as Response.StreamPart<Record<string, Tool.Any>>,
                      toolName,
                    );
                     if (frame?._tag === "text.delta") responseText += frame.text;
                     return frame ? emit(frame) : Effect.void;
                  }),
                ),
            ),
             Effect.onExit((exit) => settle(turn, exit, responseText)),
            // settle has already reported the failure as turn.end{failed}, so the
            // transcript is this turn's error channel and there is nothing left to
            // raise. A provider 500 ends a turn, never the session. catchAll takes
            // only typed failures: interruption still unwinds, defects still crash.
            Effect.catchAll(() => Effect.void),
          );
        }),
      );

    // One turn at a time: a steer that lands mid-turn queues the next prompt
    // rather than racing the running one. An interrupted turn must not end the
    // session, so the join failure is absorbed here.
    const drain = Effect.forever(
      Queue.take(inbox).pipe(
        Effect.flatMap((prompt) =>
          FiberHandle.run(running, runTurn(prompt)).pipe(
            Effect.flatMap(Fiber.join),
            Effect.catchAllCause(() => Effect.void),
          ),
        ),
      ),
    );
    const drainFiber = yield* Effect.forkScoped(drain);

    return {
      steer: (message) => Queue.offer(inbox, message).pipe(Effect.asVoid),
      // Interruption is Effect's, so the provider request, the stream and every
      // finalizer unwind together; there is no abort flag to keep in sync.
      interrupt: () => FiberHandle.clear(running),
      close: Fiber.interrupt(drainFiber).pipe(Effect.asVoid),
    } satisfies AgentWorker;
  });
}
