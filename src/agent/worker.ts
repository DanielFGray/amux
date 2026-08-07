import { Cause, Deferred, Effect, Fiber, Queue, Scope, Stream } from "effect";
import { type AgentFrame } from "../effect/AttachProtocol.ts";

export type AgentTurn = {
  readonly id: string;
  readonly prompt: string;
};

export type AgentModelPart =
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "tool"; readonly call: string; readonly tool: string; readonly input: unknown }
  | {
      readonly _tag: "result";
      readonly call: string;
      readonly output: unknown;
      readonly isError?: boolean;
    };

export type AgentModel = (input: {
  readonly prompt: string;
  readonly signal: AbortSignal;
}) => Stream.Stream<AgentModelPart, unknown>;

export const modelParts = (
  parts: Iterable<{
    readonly type: string;
    readonly delta?: string;
    readonly id?: string;
    readonly name?: string;
    readonly params?: unknown;
    readonly result?: unknown;
    readonly isError?: boolean;
  }>,
): AgentModelPart[] => {
  const result: AgentModelPart[] = [];
  for (const part of parts) {
    if (part.type === "text-delta" && part.delta) result.push({ _tag: "text", text: part.delta });
    else if (part.type === "tool-call" && part.id && part.name)
      result.push({ _tag: "tool", call: part.id, tool: part.name, input: part.params });
    else if (part.type === "tool-result" && part.id)
      result.push({
        _tag: "result",
        call: part.id,
        output: part.result,
        isError: part.isError,
      });
  }
  return result;
};

export type AgentWorker = {
  readonly steer: (message: string) => Effect.Effect<void>;
  readonly interrupt: (reason?: string) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
};

type AgentFramePayload =
  | {
      readonly _tag: "agent.status";
      readonly state: "idle" | "working" | "blocked" | "failed" | "done";
    }
  | { readonly _tag: "turn.start"; readonly turn: string; readonly prompt: string }
  | { readonly _tag: "text.delta"; readonly turn: string; readonly text: string }
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
    };

/**
 * Run one native-agent session. The model is injected so the scheduler can be
 * tested without credentials; the process entry point supplies the provider.
 */
export function makeAgentWorker(options: {
  readonly session: string;
  readonly model: AgentModel;
  readonly executeTool?: (tool: string, input: unknown) => Effect.Effect<unknown, unknown>;
  readonly emit: (frame: AgentFrame) => Effect.Effect<void>;
}): Effect.Effect<AgentWorker, never, Scope.Scope> {
  return Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<string>();
    let sequence = 0;
    let turn = 0;
    let active: Fiber.RuntimeFiber<void, unknown> | undefined;
    let activeController: AbortController | undefined;
    let activeInterrupt: Deferred.Deferred<void> | undefined;
    let interrupted = false;
    let activeTurn: string | undefined;

    const emit = (frame: AgentFramePayload) =>
      options.emit({ ...frame, session: options.session, sequence: sequence++ } as AgentFrame);

    const runTurn = (prompt: string) =>
      Effect.gen(function* () {
        const id = `turn-${++turn}`;
        activeTurn = id;
        const controller = new AbortController();
        activeController = controller;
        const interrupt = yield* Deferred.make<void>();
        activeInterrupt = interrupt;
        interrupted = false;
        yield* emit({ _tag: "agent.status", state: "working" });
        yield* emit({ _tag: "turn.start", turn: id, prompt });
        let nextPrompt = prompt;
        let continued = true;
        while (continued) {
          continued = false;
          const toolResults: string[] = [];
          const stream = options.model({ prompt: nextPrompt, signal: controller.signal });
          const exit = yield* stream.pipe(
            Stream.interruptWhen(Deferred.await(interrupt)),
            Stream.runForEach((part) =>
              Effect.gen(function* () {
                if (part._tag === "text") {
                  yield* emit({ _tag: "text.delta", turn: id, text: part.text });
                } else if (part._tag === "tool") {
                  yield* emit({
                    _tag: "tool.start",
                    turn: id,
                    call: part.call,
                    tool: part.tool,
                    input: part.input,
                  });
                  if (options.executeTool) {
                    const result = yield* options.executeTool(part.tool, part.input).pipe(
                      Effect.map((output) => ({ output, isError: false })),
                      Effect.catchAll((error) =>
                        Effect.succeed({ output: String(error), isError: true }),
                      ),
                    );
                    yield* emit({
                      _tag: "tool.result",
                      turn: id,
                      call: part.call,
                      output: result.output,
                      isError: result.isError,
                    });
                    toolResults.push(JSON.stringify({ call: part.call, output: result.output }));
                    continued = true;
                  }
                } else {
                  yield* emit({
                    _tag: "tool.result",
                    turn: id,
                    call: part.call,
                    output: part.output,
                    isError: part.isError ?? false,
                  });
                }
              }),
            ),
            Effect.exit,
          );
          if (exit._tag === "Failure") {
            if (interrupted || Cause.isInterruptedOnly(exit.cause)) {
              controller.abort();
              yield* emit({ _tag: "turn.end", turn: id, outcome: "interrupted" });
              yield* emit({ _tag: "agent.status", state: "idle" });
              activeController = undefined;
              activeInterrupt = undefined;
              activeTurn = undefined;
              return;
            }
            yield* emit({ _tag: "turn.end", turn: id, outcome: "failed" });
            yield* emit({ _tag: "agent.status", state: "failed" });
            activeController = undefined;
            activeInterrupt = undefined;
            activeTurn = undefined;
            return;
          }
          if (continued) nextPrompt = `${prompt}\n\nTool results:\n${toolResults.join("\n")}`;
        }
        if (interrupted) {
          controller.abort();
          yield* emit({ _tag: "turn.end", turn: id, outcome: "interrupted" });
          yield* emit({ _tag: "agent.status", state: "idle" });
          activeController = undefined;
          activeInterrupt = undefined;
          activeTurn = undefined;
          return;
        }
        yield* emit({ _tag: "turn.end", turn: id, outcome: "completed" });
        yield* emit({ _tag: "agent.status", state: "idle" });
        activeController = undefined;
        activeInterrupt = undefined;
        activeTurn = undefined;
      }).pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause) && activeTurn
            ? Effect.gen(function* () {
                yield* emit({ _tag: "turn.end", turn: activeTurn!, outcome: "interrupted" });
                yield* emit({ _tag: "agent.status", state: "idle" });
                activeController = undefined;
              })
              : Effect.failCause(cause),
        ),
      );

    const drain = Effect.forever(
      Queue.take(inbox).pipe(
        Effect.flatMap((prompt) => {
          return Effect.gen(function* () {
            active = yield* Effect.fork(runTurn(prompt));
            yield* Fiber.join(active);
            active = undefined;
          });
        }),
      ),
    );
    const drainFiber = yield* Effect.forkScoped(drain);

    return {
      steer: (message) => Queue.offer(inbox, message).pipe(Effect.asVoid),
      interrupt: () =>
        Effect.gen(function* () {
          interrupted = true;
          activeController?.abort();
          if (activeInterrupt) yield* Deferred.succeed(activeInterrupt, void 0);
        }),
      close: Fiber.interrupt(drainFiber),
    } satisfies AgentWorker;
  });
}
