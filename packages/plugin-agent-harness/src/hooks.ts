/**
 * Pi-shaped harness lifecycle hooks, as an ordinary listener registry inside
 * the agent-harness plugin — not a second extension runtime.
 *
 * Event vocabulary cite: ../pi/packages/coding-agent/docs/extensions.md and
 * src/core/extensions/types.ts (tool_call, before_agent_start, turn_*, …).
 *
 * Pi → amux contribution map:
 * | Pi event              | Amux seam                                         |
 * |-----------------------|---------------------------------------------------|
 * | tool_call             | HarnessHooks.emitToolCall before permission ask   |
 * | before_agent_start    | HarnessHooks.emit at worker session start         |
 * | turn_start / turn_end | HarnessHooks.emit around runTurn                  |
 * | session_compact       | compaction owner fires this when it lands         |
 * | context inject        | context.ts instructionFiles (already)             |
 * | registerTool/Command  | existing plugin contribution tables               |
 *
 * Subscriptions are Scope-owned (same pattern as `makeCompletionSources.register`):
 * `on` installs a finalizer; there is no manual unsubscribe return value.
 */
import { Effect, Scope } from "effect";
import type { JsonValue } from "@danielfgray/amux";

export type HarnessHookEvent =
  | {
      readonly _tag: "before_agent_start";
      readonly session: string;
      readonly model: string;
    }
  | {
      readonly _tag: "turn_start";
      readonly session: string;
      readonly turn: string;
    }
  | {
      readonly _tag: "turn_end";
      readonly session: string;
      readonly turn: string;
    }
  | {
      readonly _tag: "tool_call";
      readonly session: string;
      readonly turn: string;
      readonly tool: string;
      readonly action: string;
      readonly resources: readonly string[];
      readonly input: JsonValue;
      readonly call?: string;
    }
  | {
      readonly _tag: "session_compact";
      readonly session: string;
      readonly summary: string;
    };

export type ToolCallHookResult =
  | { readonly block: true; readonly reason: string }
  | { readonly block?: false };

export type HarnessHookHandler<E extends HarnessHookEvent["_tag"]> = (
  event: Extract<HarnessHookEvent, { _tag: E }>,
) => Effect.Effect<E extends "tool_call" ? ToolCallHookResult | void : void>;

export interface HarnessHooks {
  readonly on: <E extends HarnessHookEvent["_tag"]>(
    event: E,
    handler: HarnessHookHandler<E>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly emit: (event: HarnessHookEvent) => Effect.Effect<void>;
  readonly emitToolCall: (
    event: Extract<HarnessHookEvent, { _tag: "tool_call" }>,
  ) => Effect.Effect<ToolCallHookResult>;
}

type Handler = (event: HarnessHookEvent) => Effect.Effect<ToolCallHookResult | void>;

export const makeHarnessHooks = (): HarnessHooks => {
  const handlers = new Map<HarnessHookEvent["_tag"], Handler[]>();

  const on = <E extends HarnessHookEvent["_tag"]>(
    event: E,
    handler: HarnessHookHandler<E>,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const wrapped: Handler = (payload) =>
        payload._tag === event
          ? (handler as (event: HarnessHookEvent) => Effect.Effect<ToolCallHookResult | void>)(
              payload,
            )
          : Effect.void;
      handlers.set(event, [...(handlers.get(event) ?? []), wrapped]);
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          handlers.set(
            event,
            (handlers.get(event) ?? []).filter((entry) => entry !== wrapped),
          );
        }),
      );
    });

  const emit = (event: HarnessHookEvent) =>
    Effect.forEach(handlers.get(event._tag) ?? [], (handler) => handler(event), {
      discard: true,
    }).pipe(Effect.asVoid);

  const emitToolCall = (event: Extract<HarnessHookEvent, { _tag: "tool_call" }>) =>
    Effect.gen(function* () {
      for (const handler of handlers.get("tool_call") ?? []) {
        const result = yield* handler(event);
        if (result && result.block === true) return result;
      }
      return { block: false } as const;
    });

  return { on, emit, emitToolCall };
};
