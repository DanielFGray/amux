import { Effect, Layer, Option, Stream } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
  definePlugin,
  ProcessStateAuthority,
  ProcessDisplayTag,
  SessionFactsTag,
  SessionStreamTag,
  type PluginDefinition,
} from "@danielfgray/amux";
import { deriveProcessDisplay } from "./display-state.ts";
import { detectorRegions, evaluateAgent } from "./detector.ts";
import {
  AgentManifestRegistry,
  configHome,
  loadRegistry,
  type AgentManifestRegistryService,
} from "@danielfgray/amux-agent-facts/manifests.ts";
import { splitActivity } from "@danielfgray/amux-agent-facts/identify.ts";
export { identifyAgent } from "@danielfgray/amux-agent-facts/identify.ts";
export { AgentManifestRegistry } from "@danielfgray/amux-agent-facts/manifests.ts";
export { configHome, loadRegistry } from "@danielfgray/amux-agent-facts/manifests.ts";
export { readHarnessLog } from "@danielfgray/amux-agent-facts/harness-log.ts";
import {
  AgentAwarenessTag,
  hookAgentFromFrame,
  resolveAgentId,
  resolvePresence,
  type AgentPresence,
} from "./presence.ts";

/**
 * The default policy for recognising and presenting coding-agent process
 * state. Core supplies only neutral process facts; this plugin decides what
 * those facts mean to an agent-aware UI.
 */
export const agentAwarenessPlugin: PluginDefinition = definePlugin({
  id: "amux.agent-awareness",
  inject: [ProcessDisplayTag, SessionFactsTag, SessionStreamTag],
  provide: [AgentAwarenessTag, AgentManifestRegistry],
  effect: (ctx) =>
    Effect.gen(function* () {
      const registry: AgentManifestRegistryService = yield* loadRegistry(
        yield* configHome.pipe(Effect.orDie),
      ).pipe(Effect.provide(BunFileSystem.layer.pipe(Layer.provideMerge(BunPath.layer))));
      ctx.provide(AgentManifestRegistry, registry);
      const processDisplay = yield* ProcessDisplayTag;
      const facts = yield* SessionFactsTag;
      const sessionStream = yield* SessionStreamTag;
      const observation = yield* facts.observe(detectorRegions(registry));
      const hookAgents = new Map<string, string>();
      const presenceOf = (session: string): AgentPresence | undefined => {
        const fact = observation.current()[session];
        return fact ? resolvePresence(registry, session, fact, hookAgents.get(session)) : undefined;
      };
      ctx.provide(AgentAwarenessTag, { presence: presenceOf });

      const registered = new Set<string>();
      const register = Effect.fnUntraced(function* (session: string) {
        if (registered.has(session)) return;
        registered.add(session);
        yield* Stream.runForEach(sessionStream.frames(session), (frame) => {
          const agent = hookAgentFromFrame(frame);
          if (agent) hookAgents.set(session, agent);
          return Effect.void;
        }).pipe(Effect.forkScoped);
        yield* facts.registerStateSource(session, {
          authority: ProcessStateAuthority.Detector,
          state: () => {
            const fact = observation.current()[session];
            if (!fact) return "unknown";
            return Option.match(resolveAgentId(registry, fact, hookAgents.get(session)), {
              onNone: () => "unknown",
              onSome: (agent) => {
                const result = evaluateAgent(registry, agent, fact.regions);
                return result.skipStateUpdate ? "unknown" : result.state;
              },
            });
          },
        });
      });
      yield* Effect.forEach(Object.keys(observation.current()), register, { discard: true });
      yield* Stream.runForEach(observation.invalidations, (event) => register(event.session)).pipe(
        Effect.forkScoped,
      );
      yield* processDisplay.register((displayFacts) => {
        const presence = displayFacts.session ? presenceOf(displayFacts.session) : undefined;
        return {
          ...deriveProcessDisplay(displayFacts),
          title: splitActivity(displayFacts.title).text,
          agent: presence?.agent ?? null,
        };
      });
    }),
});

export default agentAwarenessPlugin;
