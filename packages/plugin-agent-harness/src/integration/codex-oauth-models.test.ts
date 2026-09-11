import { expect, test } from "bun:test";
import {
  CODEX_OAUTH_ALLOWED_MODELS,
  codexOAuthModels,
  isCodexOAuthModel,
  zeroCodexOAuthCost,
} from "./codex-oauth-models.ts";

test("isCodexOAuthModel keeps the OpenCode allowlist and any id containing codex", () => {
  for (const id of CODEX_OAUTH_ALLOWED_MODELS) {
    expect(isCodexOAuthModel(id)).toBe(true);
  }
  expect(isCodexOAuthModel("gpt-5.3-codex-spark")).toBe(true);
  expect(isCodexOAuthModel("gpt-5.6-luna")).toBe(true);
  expect(isCodexOAuthModel("gpt-4o")).toBe(false);
  expect(isCodexOAuthModel("gpt-5.1")).toBe(false);
});

test("codexOAuthModels drops non-Codex rows and zeroes cost", () => {
  const models = codexOAuthModels({
    "gpt-4o": {
      id: "gpt-4o",
      cost: { input: 2.5, output: 10, cache_read: 1.25 },
    },
    "gpt-5.4": {
      id: "gpt-5.4",
      cost: { input: 2.5, output: 15, cache_read: 0.25, cache_write: 1 },
    },
    "gpt-5.3-codex-spark": {
      id: "gpt-5.3-codex-spark",
      cost: { input: 1, output: 2 },
    },
  });
  expect(Object.keys(models).sort()).toEqual(["gpt-5.3-codex-spark", "gpt-5.4"]);
  expect(models["gpt-5.4"]?.cost).toEqual({
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  });
  expect(models["gpt-5.3-codex-spark"]?.cost).toEqual({
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  });
});

test("zeroCodexOAuthCost invents a zero row when cost was absent", () => {
  expect(zeroCodexOAuthCost(undefined)).toEqual({
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  });
});
