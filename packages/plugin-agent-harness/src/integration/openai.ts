import { openAiCompatible } from "./openai-compatible.ts";

export const openai = openAiCompatible({ id: "openai", label: "OpenAI", env: "OPENAI_API_KEY" });
