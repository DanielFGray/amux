import { openAiCompatible } from "./openai-compatible.ts";

/**
 * OpenCode's two model gateways.
 *
 * Both are OpenAI-compatible and take one API key, so both are the factory with
 * a name. They are separate integrations rather than one with a tier setting
 * because the model catalog lists them as separate providers, and a model
 * reference is `provider/model` — `opencode-go/glm-5` has to name a provider
 * the catalog knows.
 *
 * Zen's id is `opencode`, not `opencode-zen`. That is the catalog's own id and
 * the one an `agent.model` reference has to use; renaming it here to read
 * better would make every model in it unresolvable.
 */
export const opencodeZen = openAiCompatible({ id: "opencode", label: "OpenCode Zen" });

export const opencodeGo = openAiCompatible({ id: "opencode-go", label: "OpenCode Go" });
