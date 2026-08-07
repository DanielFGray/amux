import { anthropic } from "./anthropic.ts";
import { openai } from "./openai.ts";
import type { Integration } from "./types.ts";

export const integrations: readonly Integration[] = [openai, anthropic];
export { anthropic, openai };
export type { Connection, Integration, Method, Prompt, When } from "./types.ts";
