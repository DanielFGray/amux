/**
 * Neutral agent facts: which executables identify a coding agent, and how
 * to read a harness's own durable log. Core and the agent-awareness plugin
 * both depend on this package; it depends on neither, so agent policy can
 * move into plugins without taking the facts the daemon needs with it.
 */
export {
  AgentManifests,
  buildRegistry,
  MANIFEST_ENGINE_VERSION,
  type Adapter,
  type AdapterRule,
  type AgentManifest,
  type AgentManifestRegistry,
  type RegexPattern,
  type RuleGate,
} from "./manifests.ts";
export { identifyAgent, splitActivity } from "./identify.ts";
export { readHarnessLog, type HarnessLogMessage } from "./harness-log.ts";
