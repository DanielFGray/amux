/**
 * ChatGPT Codex subscription OAuth model policy.
 *
 * Borrow: OpenCode `packages/opencode/src/plugin/codex.ts` CodexAuthPlugin
 * loader — allowlist Codex-suitable models and zero cost (included in the
 * ChatGPT subscription). Amux keeps the OAuth grant under `openai-codex`
 * while the upstream catalog still lists those models under `openai`.
 */

/** Catalog id for the projected Codex OAuth provider (integration id). */
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

/** Upstream catalog provider that owns the model rows we filter. */
export const OPENAI_CODEX_SOURCE_PROVIDER_ID = "openai";

/**
 * Explicit allowlist: OpenCode's CodexAuthPlugin set, plus Codex CLI
 * `models-manager/models.json` gpt-5.6 family (luna/sol/terra). Any id
 * containing `codex` also passes — see `isCodexOAuthModel`.
 */
export const CODEX_OAUTH_ALLOWED_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

export const isCodexOAuthModel = (modelId: string): boolean =>
  modelId.includes("codex") || CODEX_OAUTH_ALLOWED_MODELS.has(modelId);

type CostFields = {
  readonly input: number;
  readonly output: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
};

type CodexOAuthModelRow = {
  readonly id: string;
  readonly cost?: CostFields;
};

/** Subscription-included: OpenCode zeroes input/output/cache for OAuth. */
export const zeroCodexOAuthCost = <C extends CostFields>(cost: C | undefined): C | undefined => {
  if (cost === undefined) {
    return { input: 0, output: 0, cache_read: 0, cache_write: 0 } as C;
  }
  return { ...cost, input: 0, output: 0, cache_read: 0, cache_write: 0 };
};

/**
 * Keep Codex-suitable rows and zero their cost. Keys are catalog model ids
 * (OpenCode keeps `modelId.includes("codex")` even when outside the set).
 */
export const codexOAuthModels = <M extends CodexOAuthModelRow>(
  models: Readonly<Record<string, M>>,
) => {
  const next = {} as Record<string, M>;
  for (const [modelId, model] of Object.entries(models)) {
    if (!isCodexOAuthModel(modelId) && !isCodexOAuthModel(model.id)) continue;
    next[modelId] = { ...model, cost: zeroCodexOAuthCost(model.cost) };
  }
  return next;
};
