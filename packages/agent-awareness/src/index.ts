import { Effect, Stream } from "effect";
import {
  definePlugin,
  ProcessStateAuthority,
  ProcessDisplayTag,
  SessionFactsTag,
  SessionStreamTag,
  type PluginDefinition,
} from "@danielfgray/amux";
import { deriveProcessDisplay } from "./display-state.ts";
import { DETECTOR_REGIONS, evaluateAgent } from "./detector.ts";
import { splitActivity } from "@danielfgray/amux-agent-facts/identify.ts";
export { identifyAgent } from "@danielfgray/amux-agent-facts/identify.ts";
export { readHarnessLog } from "@danielfgray/amux-agent-facts/harness-log.ts";
import {
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
  effect: () =>
    Effect.gen(function* () {
      const processDisplay = yield* ProcessDisplayTag;
      const facts = yield* SessionFactsTag;
      const sessionStream = yield* SessionStreamTag;
      const observation = yield* facts.observe(DETECTOR_REGIONS);
      const hookAgents = new Map<string, string>();
      const presenceOf = (session: string): AgentPresence | undefined => {
        const fact = observation.current()[session];
        return fact ? resolvePresence(session, fact, hookAgents.get(session)) : undefined;
      };

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
            const agent = resolveAgentId(fact, hookAgents.get(session));
            if (!agent) return "unknown";
            const result = evaluateAgent(agent, fact.regions);
            return result.skipStateUpdate ? "unknown" : result.state;
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
