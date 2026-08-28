import type { OptionSpec } from "@danielfgray/amux"

/**
 * The native harness's own option declarations, registered through
 * `OptionsTag` — see agent-harness.tsx. Kept beside `parseModelReference`
 * because both are model policy this harness owns; core has no idea a model
 * exists.
 */
export const AGENT_HARNESS_OPTIONS = {
  "agent.model": {
    kind: "string",
    default: "openai/gpt-4o-mini",
    desc: "provider/model for native agents",
    editable: true,
  },
  "agent.showThinking": {
    kind: "boolean",
    default: false,
    desc: "show agent thinking traces",
  },
} as const satisfies Record<string, OptionSpec>;

export function parseModelReference(
  value: string,
): { readonly providerID: string; readonly modelID: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}
