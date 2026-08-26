import { openAiCompatible } from "./openai-compatible.ts";

/**
 * OpenCode's two model gateways, Zen and Go, under one connection.
 *
 * Both are OpenAI-compatible and take the same `OPENCODE_API_KEY`, but the
 * model catalog lists them as separate providers — "opencode" and
 * "opencode-go" — because their hosts and model lists differ, and a model
 * reference (`provider/model`) has to name whichever one it means. `id`
 * stays "opencode" (models.dev's own id for Zen, not "opencode-zen") since
 * that is where a new connection is stored; "opencode-go" is an alias so the
 * same credential answers for both rather than asking for the key twice.
 */
export const opencode = openAiCompatible({
  id: "opencode",
  label: "OpenCode",
  env: "OPENCODE_API_KEY",
  aliases: ["opencode-go"],
});
