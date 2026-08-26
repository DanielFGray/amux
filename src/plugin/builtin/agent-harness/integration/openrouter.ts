import { openAiCompatible } from "./openai-compatible.ts";

export const openrouter = openAiCompatible({
  id: "openrouter",
  label: "OpenRouter",
  env: "OPENROUTER_API_KEY",
});
