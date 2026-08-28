import { Effect, Stream } from "effect";
import {
  definePlugin,
  ProcessStateAuthority,
  ProcessDisplayTag,
  SessionFactsTag,
  type SessionFact,
  type PluginDefinition,
} from "@danielfgray/amux";
import { deriveProcessDisplay } from "./display-state.ts";
import { DETECTOR_REGIONS, evaluateAgent } from "./detector.ts";
import { identifyAgent, splitActivity } from "./identify.ts";

const identity = (fact: SessionFact): string | null =>
  fact.declaredAgent ?? identifyAgent(fact.command) ?? identifyAgent(fact.foreground?.argv ?? []);

/**
 * The default policy for recognising and presenting coding-agent process
 * state. Core supplies only neutral process facts; this plugin decides what
 * those facts mean to an agent-aware UI.
 */
export const agentAwarenessPlugin: PluginDefinition = definePlugin({
  id: "amux.agent-awareness",
  apiVersion: "1",
  inject: [ProcessDisplayTag, SessionFactsTag],
  effect: () =>
    Effect.gen(function* () {
      const processDisplay = yield* ProcessDisplayTag;
      const facts = yield* SessionFactsTag;
      const observation = yield* facts.observe(DETECTOR_REGIONS);
      const registered = new Set<string>();
      const register = Effect.fnUntraced(function* (session: string) {
        if (registered.has(session)) return;
        registered.add(session);
        yield* facts.registerStateSource(session, {
          authority: ProcessStateAuthority.Detector,
          state: () => {
            const fact = observation.current()[session];
            if (!fact) return "unknown";
            const agent = identity(fact);
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
        const fact = displayFacts.session ? observation.current()[displayFacts.session] : undefined;
        return {
          ...deriveProcessDisplay(displayFacts),
          title: splitActivity(displayFacts.title).text,
          agent: fact ? identity(fact) : null,
        };
      });
    }),
});

export default agentAwarenessPlugin;
