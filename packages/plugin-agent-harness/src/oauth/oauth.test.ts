/** @effect-diagnostics *:skip-file -- drives real loopback HTTP with fetch against acquireLoopbackCallback; HttpClient would not exercise the Bun.serve finalizer this suite asserts. */
import { expect, test } from "bun:test";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Effect, Encoding, Redacted, Result } from "effect";
import { testEffect } from "@danielfgray/amux/testing";
import {
  acquireLoopbackCallback,
  generatePkce,
  parseCallbackInput,
  pollDeviceCodeFlow,
  OAuthFailed,
  OAuthTimeout,
  type OAuthFlowController,
} from "./index.ts";
import { loginCodex, makeOpenaiCodex, parseJwtClaims, refreshCodex } from "../integration/index.ts";

testEffect("generatePkce returns base64url verifier and S256 challenge", () =>
  Effect.gen(function* () {
    const { verifier, challenge } = yield* generatePkce;
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge.length).toBeGreaterThan(40);
    expect(verifier).not.toContain("+");
    expect(challenge).not.toContain("=");
  }),
);

test("parseCallbackInput accepts URL, query, and raw code#state", () => {
  expect(parseCallbackInput("http://localhost:1455/auth/callback?code=abc&state=xyz")).toEqual({
    code: "abc",
    state: "xyz",
  });
  expect(parseCallbackInput("code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
  expect(parseCallbackInput("abc#xyz")).toEqual({ code: "abc", state: "xyz" });
  expect(parseCallbackInput("   ")).toEqual({});
});

testEffect("device-code poll completes, fails, and times out", () =>
  Effect.gen(function* () {
    let n = 0;
    const value = yield* pollDeviceCodeFlow({
      intervalSeconds: 0.01,
      expiresInSeconds: 10,
      poll: Effect.sync(() => {
        n += 1;
        if (n === 1) return { status: "pending" as const };
        return { status: "complete" as const, value: "ok" };
      }),
    });
    expect(value).toBe("ok");
    expect(n).toBe(2);

    const failed = yield* Effect.result(
      pollDeviceCodeFlow({
        poll: Effect.succeed({ status: "failed" as const, message: "denied" }),
      }),
    );
    expect(Result.isFailure(failed)).toBe(true);
    if (Result.isFailure(failed)) expect(failed.failure).toBeInstanceOf(OAuthFailed);

    const timed = yield* Effect.result(
      pollDeviceCodeFlow({
        intervalSeconds: 0.01,
        expiresInSeconds: 0,
        poll: Effect.succeed({ status: "pending" as const }),
      }),
    );
    expect(Result.isFailure(timed)).toBe(true);
    if (Result.isFailure(timed)) expect(timed.failure).toBeInstanceOf(OAuthTimeout);
  }),
);

testEffect("loopback callback resolves code and finalizer closes the port", () =>
  Effect.gen(function* () {
    const state = "test-state";
    const loopback = yield* acquireLoopbackCallback({
      preferredPort: 0,
      expectedState: state,
      path: "/auth/callback",
      allowPortFallback: true,
      timeoutMs: 5_000,
    });

    const hit = Effect.tryPromise({
      try: () =>
        fetch(`http://127.0.0.1:${loopback.port}/auth/callback?code=the-code&state=${state}`).then(
          (r) => r.text(),
        ),
      catch: (cause) => cause as Error,
    });
    const [html, result] = yield* Effect.all([hit, loopback.awaitCode], {
      concurrency: "unbounded",
    });
    expect(html).toContain("Authorization Successful");
    expect(result).toEqual({ code: "the-code", state });
  }).pipe(Effect.scoped),
);

testEffect("cancelling the Scope stops the loopback listener", () =>
  Effect.gen(function* () {
    const port = yield* Effect.scoped(
      Effect.gen(function* () {
        const loopback = yield* acquireLoopbackCallback({
          preferredPort: 0,
          expectedState: "s",
          allowPortFallback: true,
        });
        return loopback.port;
      }),
    );
    // After Scope exit the finalizer has stopped Bun.serve — connect must fail.
    const refused = yield* Effect.tryPromise({
      try: () => fetch(`http://127.0.0.1:${port}/auth/callback`).then(() => false),
      catch: () => true as const,
    }).pipe(Effect.catch(() => Effect.succeed(true as const)));
    expect(refused).toBe(true);
  }),
);

const fakeJwt = (
  claims: Record<string, string | number | boolean | null | Record<string, string>>,
) => {
  const header = Encoding.encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = Encoding.encodeBase64Url(JSON.stringify(claims));
  return `${header}.${payload}.sig`;
};

const fakeController = (paste?: string): OAuthFlowController & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    onAuth: (info) =>
      Effect.sync(() => {
        urls.push(info.url);
      }),
    onProgress: () => Effect.void,
    onManualCodeInput:
      paste !== undefined
        ? Effect.succeed(paste)
        : // Auto mode races paste against loopback — hang until interrupt, don't fail-fast.
          Effect.never,
  };
};

testEffect("Codex paste-mode login exchanges code via injectable token URL", () =>
  Effect.gen(function* () {
    const accountId = "acct_test";
    const access = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    });
    const idToken = fakeJwt({ email: "u@example.com" });

    const tokenServer = Bun.serve({
      port: 0,
      fetch(req) {
        expect(req.method).toBe("POST");
        return req.text().then((body) => {
          expect(body).toContain("grant_type=authorization_code");
          expect(body).toContain("code=pasted-code");
          return Response.json({
            access_token: access,
            refresh_token: "refresh-token",
            id_token: idToken,
            expires_in: 3600,
          });
        });
      },
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.resolve(tokenServer.stop(true))).pipe(Effect.asVoid),
    );

    const ctl = fakeController("pasted-code");
    const credential = yield* loginCodex(ctl, {
      mode: "paste",
      tokenUrl: `http://127.0.0.1:${tokenServer.port}/oauth/token`,
      authorizeUrl: "http://example.test/authorize",
      timeoutMs: 5_000,
    });

    expect(credential.type).toBe("oauth");
    expect(Redacted.value(credential.access)).toBe(access);
    expect(Redacted.value(credential.refresh)).toBe("refresh-token");
    expect(credential.metadata?.accountId).toBe(accountId);
    expect(ctl.urls[0]).toContain("code_challenge=");
    expect(ctl.urls[0]).toContain("client_id=");
  }).pipe(Effect.scoped),
);

testEffect("Codex auto-mode login: fake IdP hits real loopback then token exchange", () =>
  Effect.gen(function* () {
    const accountId = "acct_loop";
    const access = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    });

    const tokenServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          access_token: access,
          refresh_token: "r",
          expires_in: 60,
        });
      },
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.resolve(tokenServer.stop(true))).pipe(Effect.asVoid),
    );

    const ctl = fakeController();
    const login = loginCodex(ctl, {
      mode: "auto",
      preferredPort: 0,
      allowPortFallback: true,
      tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
      authorizeUrl: "http://example.test/authorize",
      timeoutMs: 5_000,
    });

    const drive = Effect.gen(function* () {
      for (let i = 0; i < 50; i++) {
        if (ctl.urls.length > 0) break;
        yield* Effect.sleep("20 millis");
      }
      const authUrl = ctl.urls[0];
      expect(authUrl).toBeDefined();
      const redirectUri = new URL(authUrl!).searchParams.get("redirect_uri");
      const state = new URL(authUrl!).searchParams.get("state");
      expect(redirectUri).toBeTruthy();
      expect(state).toBeTruthy();
      const callback = new URL(redirectUri!);
      callback.searchParams.set("code", "browser-code");
      callback.searchParams.set("state", state!);
      const res = yield* Effect.tryPromise({
        try: () => fetch(callback).then((r) => r.status),
        catch: (cause) => cause as Error,
      });
      expect(res).toBe(200);
    });

    const [credential] = yield* Effect.all([login, drive], { concurrency: "unbounded" });
    expect(Redacted.value(credential.access)).toBe(access);
    expect(credential.metadata?.accountId).toBe(accountId);
  }).pipe(Effect.scoped),
);

testEffect("refreshCodex exchanges refresh_token at the injectable token URL", () =>
  Effect.gen(function* () {
    const accountId = "acct_refresh";
    const access = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    });
    const tokenServer = Bun.serve({
      port: 0,
      fetch(req) {
        return req.text().then((body) => {
          expect(body).toContain("grant_type=refresh_token");
          expect(body).toContain("refresh_token=old-refresh");
          return Response.json({
            access_token: access,
            refresh_token: "new-refresh",
            expires_in: 120,
          });
        });
      },
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.resolve(tokenServer.stop(true))).pipe(Effect.asVoid),
    );

    const next = yield* refreshCodex(
      {
        type: "oauth",
        methodID: "chatgpt",
        access: Redacted.make("stale"),
        refresh: Redacted.make("old-refresh"),
        expires: 0,
        metadata: { accountId: "prev" },
      },
      { tokenUrl: `http://127.0.0.1:${tokenServer.port}/token` },
    );
    expect(Redacted.value(next.access)).toBe(access);
    expect(Redacted.value(next.refresh)).toBe("new-refresh");
    expect(next.metadata?.accountId).toBe(accountId);
  }).pipe(Effect.scoped),
);

test("parseJwtClaims reads chatgpt_account_id claim path", () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "a1" },
  });
  expect(parseJwtClaims(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id).toBe("a1");
});

test("openai-codex authorize stamps ChatGPT-Account-Id", () => {
  const provider = makeOpenaiCodex();
  const request = provider.authorize(
    {
      type: "oauth",
      methodID: "chatgpt",
      access: Redacted.make("tok"),
      refresh: Redacted.make("ref"),
      expires: 0,
      metadata: { accountId: "acct" },
    },
    HttpClientRequest.get("https://chatgpt.com/backend-api/codex/responses"),
  );
  expect(request.headers.authorization).toBe("Bearer tok");
  expect(request.headers["chatgpt-account-id"]).toBe("acct");
});
