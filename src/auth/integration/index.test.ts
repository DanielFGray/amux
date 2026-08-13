import { expect, test } from "bun:test";
import { HttpClientRequest } from "@effect/platform";
import { Redacted } from "effect";
import { integrations, openAiCompatible } from "./index.ts";

/**
 * The registry, and the factory most of it is built from.
 *
 * An integration's id is not a display name: it has to be the model catalog's
 * id for that provider, because an `agent.model` reference is `provider/model`
 * and the preflight looks the pair up in the catalog. An id that reads better
 * than the catalog's makes every model under it unresolvable, which is why
 * these are pinned rather than left to whatever a later edit finds tidy.
 */

test("every registered integration is named as the model catalog names it", () => {
  expect(integrations.map((integration) => integration.id)).toEqual([
    "openai",
    "anthropic",
    // models.dev calls OpenCode Zen simply "opencode". Not "opencode-zen".
    "opencode",
    "opencode-go",
  ]);
});

test("every integration offers a way to connect", () => {
  expect(integrations.length).toBeGreaterThan(0);
  for (const integration of integrations) {
    expect(integration.methods.length).toBeGreaterThan(0);
    expect(integration.label).not.toBe("");
  }
});

test("an OpenAI-compatible provider sends its key as a bearer token", () => {
  const provider = openAiCompatible({ id: "example", label: "Example" });
  const request = provider.authorize(
    { type: "key", key: Redacted.make("secret") },
    HttpClientRequest.get("https://example.test/v1/chat/completions"),
  );
  expect(request.headers.authorization).toBe("Bearer secret");
});

test("an OAuth credential authorizes with its access token, not its refresh one", () => {
  const provider = openAiCompatible({ id: "example", label: "Example" });
  const request = provider.authorize(
    {
      type: "oauth",
      methodID: "example-oauth",
      access: Redacted.make("access"),
      refresh: Redacted.make("refresh"),
      expires: 0,
    },
    HttpClientRequest.get("https://example.test/v1/chat/completions"),
  );
  expect(request.headers.authorization).toBe("Bearer access");
});
