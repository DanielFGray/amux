/**
 * Parse a pasted OAuth callback URL, query fragment, or raw code (+ optional #state).
 * Borrow: oh-my-pi `packages/ai/src/registry/oauth/callback-server.ts` parseCallbackInput.
 */
export type PastedCallback = {
  readonly code?: string;
  readonly state?: string;
};

export const parseCallbackInput = (input: string): PastedCallback => {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a URL — fall through.
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ""));
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  const [code, state] = value.split("#", 2);
  return { code, state };
};
