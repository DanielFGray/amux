import { anthropic } from "./anthropic.ts";
import { githubCopilotIntegration as githubCopilot } from "./github-copilot.ts";
import { openai } from "./openai.ts";
import { openaiCodexIntegration as openaiCodex } from "./openai-codex.ts";
import { opencode } from "./opencode.ts";
import { openrouter } from "./openrouter.ts";
import type { Integration } from "./types.ts";

export const integrations: readonly Integration[] = [
  openai,
  openaiCodex,
  githubCopilot,
  anthropic,
  opencode,
  openrouter,
];
export { anthropic, githubCopilot, openai, openaiCodex, opencode, openrouter };
export {
  loginCodex,
  loginCodexDevice,
  refreshCodex,
  openaiCodex as makeOpenaiCodex,
  extractAccountId,
  parseJwtClaims,
} from "./openai-codex.ts";
export {
  authorizeCopilot,
  copilotApiBase,
  GITHUB_COPILOT_CLIENT_ID_CONFIG,
  githubCopilot as makeGithubCopilot,
  loginCopilot,
  normalizeDomain,
} from "./github-copilot.ts";
export {
  CODEX_OAUTH_ALLOWED_MODELS,
  OPENAI_CODEX_PROVIDER_ID,
  codexOAuthModels,
  isCodexOAuthModel,
} from "./codex-oauth-models.ts";

export { openAiCompatible } from "./openai-compatible.ts";
export * as OpenAiChat from "./openai-chat.ts";
export type { Connection, Integration, Method, ModelRequest, Prompt, When } from "./types.ts";
