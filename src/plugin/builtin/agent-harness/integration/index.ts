import { anthropic } from "./anthropic.ts";
import { openai } from "./openai.ts";
import { opencode } from "./opencode.ts";
import { openrouter } from "./openrouter.ts";
import type { Integration } from "./types.ts";

export const integrations: readonly Integration[] = [openai, anthropic, opencode, openrouter];
export { anthropic, openai, opencode, openrouter };
export { openAiCompatible } from "./openai-compatible.ts";
export * as OpenAiChat from "./openai-chat.ts";
export type { Connection, Integration, Method, ModelRequest, Prompt, When } from "./types.ts";
