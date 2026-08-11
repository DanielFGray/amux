import { anthropic } from "./anthropic.ts";
import { openai } from "./openai.ts";
import { opencodeGo, opencodeZen } from "./opencode.ts";
import type { Integration } from "./types.ts";

export const integrations: readonly Integration[] = [openai, anthropic, opencodeZen, opencodeGo];
export { anthropic, openai, opencodeGo, opencodeZen };
export { openAiCompatible } from "./openai-compatible.ts";
export type { Connection, Integration, Method, ModelRequest, Prompt, When } from "./types.ts";
