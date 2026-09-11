import { expect, test } from "bun:test";
import { Effect, Option, Stream } from "effect";
import {
  ProcessState,
  type SessionFact,
  ProcessDisplayTag,
  SessionFactsTag,
  SessionStreamTag,
  definePlugin,
  type PluginDefinition,
} from "@danielfgray/amux";
import { createPluginContributions } from "@danielfgray/amux/plugin/contributions.ts";
import { createPluginHost, type PluginEnvironment } from "@danielfgray/amux/plugin/host.ts";
import { resolvePresence } from "./presence.ts";
import { AgentAwarenessTag } from "./presence.ts";
import agentAwarenessPlugin from "./index.ts";
import { bundledRegistry } from "@danielfgray/amux-agent-facts/manifests.ts";

function fact(overrides: Partial<SessionFact> = {}): SessionFact {
  return {
    id: "s1",
    revision: 1,
    lifecycle: "running",
    exitCode: null,
    processState: null,
    command: [],
    declaredAgent: null,
    foreground: null,
    outputRevision: 0,
    screenRevision: 0,
    regions: {},
    ...overrides,
  };
}

const noopHostServices: PluginDefinition = definePlugin({
  id: "test.session-facts",
  provide: [ProcessDisplayTag, SessionFactsTag, SessionStreamTag],
  effect: (ctx) =>
    Effect.sync(() => {
      ctx.provide(ProcessDisplayTag, {
        register: () => Effect.void,
        display: () => ({ glyph: "?", label: "unknown", rank: 0 }),
      });
      ctx.provide(SessionStreamTag, { frames: () => Stream.empty, sync: () => {} });
      ctx.provide(SessionFactsTag, {
        observe: () =>
          Effect.succeed({
            current: () => ({
              s1: fact({ declaredAgent: "claude", processState: ProcessState.Running }),
            }),
            invalidations: Stream.empty,
          }),
        registerStateSource: () => Effect.void,
      });
    }),
});

test("agentAwarenessPlugin publishes presence matching resolvePresence for the same fact", () =>
  Effect.gen(function* () {
    const environment: PluginEnvironment = { contributions: createPluginContributions() };
    const host = yield* createPluginHost(environment);
    yield* Effect.orDie(host.reconcile([noopHostServices, agentAwarenessPlugin]));
    const awareness = Option.getOrThrow(host.get(AgentAwarenessTag));
    const expected = resolvePresence(
      bundledRegistry(),
      "s1",
      fact({ declaredAgent: "claude", processState: ProcessState.Running }),
      undefined,
    );
    expect(awareness.presence("s1")).toEqual(expected);
    expect(awareness.presence("unknown-session")).toBeUndefined();
  }).pipe(Effect.scoped, Effect.runPromise));
