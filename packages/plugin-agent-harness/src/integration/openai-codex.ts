/**
 * ChatGPT / Codex OAuth adapter — thin wrappers over oauth/ primitives.
 * Borrow: oh-my-pi `registry/oauth/openai-codex.ts`, opencode `plugin/codex.ts`,
 * Codex `device_code_auth.rs` (device/headless).
 *
 * Provider-local only: client_id, auth.openai.com endpoints, JWT → accountId,
 * Codex API host/headers. PKCE / loopback / paste / device poll live in oauth/.
 */
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Encoding, Layer, Redacted, Result, Schema as S } from "effect";
import * as os from "node:os";
import { OAuthRefreshError, type Credential } from "../credential.ts";
import {
  acquireLoopbackCallback,
  awaitAuthorizationCode,
  generatePkce,
  generateState,
  pollDeviceCodeFlow,
  type OAuthError,
  type OAuthFlowController,
  OAuthFailed,
} from "../oauth/index.ts";
import { openAiReasoningConfig } from "./thinking.ts";
import type { Integration, Method } from "./types.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const DEFAULT_AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const DEFAULT_TOKEN_URL = `${ISSUER}/oauth/token`;
/** Codex `device_code_auth.rs` + OpenCode headless: `{issuer}/api/accounts/deviceauth/*`. */
const DEFAULT_DEVICE_USERCODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEFAULT_DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const DEFAULT_DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const DEFAULT_DEVICE_VERIFICATION_URL = `${ISSUER}/codex/device`;
const DEVICE_EXPIRES_SECONDS = 15 * 60;
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const OAUTH_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const CODEX_API_URL = "https://chatgpt.com/backend-api/codex";
const METHOD_ID = "chatgpt";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
/** package.json version — no install-time VERSION helper yet (opencode Installation.VERSION). */
const AMUX_VERSION = "0.1.0";
/** OpenCode `chat.headers` / Codex default_client: originator + User-Agent on API requests. */
const CODEX_USER_AGENT = `amux/${AMUX_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`;

const TokenResponse = S.Struct({
  access_token: S.String,
  refresh_token: S.String,
  id_token: S.optional(S.String),
  expires_in: S.Finite,
});

const DeviceUserCodeResponse = S.Struct({
  device_auth_id: S.String,
  user_code: S.String,
  interval: S.optional(S.Union([S.String, S.Finite])),
});

const DeviceCodeSuccess = S.Struct({
  authorization_code: S.String,
  code_verifier: S.String,
  code_challenge: S.optional(S.String),
});

const DeviceUserCodeRequest = S.Struct({
  client_id: S.String,
});

const DeviceTokenPollRequest = S.Struct({
  device_auth_id: S.String,
  user_code: S.String,
});

export type CodexLoginMode = "auto" | "paste" | "device";

export type CodexEndpoints = {
  readonly authorizeUrl?: string;
  readonly tokenUrl?: string;
  readonly preferredPort?: number;
  readonly allowPortFallback?: boolean;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable device-auth endpoints (tests). Defaults match live ChatGPT IdP. */
  readonly deviceUserCodeUrl?: string;
  readonly deviceTokenUrl?: string;
  readonly deviceRedirectUri?: string;
  readonly deviceVerificationUrl?: string;
};

type IdTokenClaims = {
  readonly chatgpt_account_id?: string;
  readonly organizations?: ReadonlyArray<{ readonly id?: string }>;
  readonly email?: string;
  readonly [JWT_AUTH_CLAIM]?: { readonly chatgpt_account_id?: string };
};

/** Decode a JWT payload without verifying — IdP already issued it. */
export const parseJwtClaims = (token: string): IdTokenClaims | undefined => {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = Encoding.decodeBase64UrlString(parts[1]!);
    if (Result.isFailure(json)) return undefined;
    return JSON.parse(json.success) as IdTokenClaims;
  } catch {
    return undefined;
  }
};

export const extractAccountId = (accessToken: string, idToken?: string): string | undefined => {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    if (!claims) continue;
    const id =
      claims.chatgpt_account_id ??
      claims[JWT_AUTH_CLAIM]?.chatgpt_account_id ??
      claims.organizations?.[0]?.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
};

const buildAuthorizeUrl = (args: {
  readonly authorizeUrl: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
}): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: args.redirectUri,
    scope: SCOPE,
    code_challenge: args.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: args.state,
    originator: "amux",
  });
  return `${args.authorizeUrl}?${params.toString()}`;
};

const exchangeCode = Effect.fnUntraced(function* (args: {
  readonly tokenUrl: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly verifier: string;
  readonly fetch: typeof globalThis.fetch;
}) {
  const response = yield* Effect.tryPromise({
    try: () =>
      args.fetch(args.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: args.code,
          redirect_uri: args.redirectUri,
          client_id: CLIENT_ID,
          code_verifier: args.verifier,
        }).toString(),
      }),
    catch: (cause) =>
      new OAuthFailed({
        message: cause instanceof Error ? cause.message : String(cause),
        kind: "token-exchange",
      }),
  });
  if (!response.ok) {
    return yield* new OAuthFailed({
      message: `Token exchange failed: ${response.status}`,
      kind: "token-exchange",
    });
  }
  const body = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => new OAuthFailed({ message: "Token response was not JSON", kind: "validation" }),
  });
  const decoded = yield* S.decodeUnknownEffect(TokenResponse)(body).pipe(
    Effect.mapError(
      (err) =>
        new OAuthFailed({
          message: `Token response missing fields: ${String(err)}`,
          kind: "validation",
        }),
    ),
  );
  const accountId = extractAccountId(decoded.access_token, decoded.id_token);
  if (!accountId) {
    return yield* new OAuthFailed({
      message: "Failed to extract accountId from token",
      kind: "validation",
    });
  }
  const now = yield* Effect.clockWith((c) => c.currentTimeMillis);
  const email = parseJwtClaims(decoded.id_token ?? "")?.email;
  const metadata = email !== undefined ? { accountId, email } : { accountId };
  return {
    type: "oauth" as const,
    methodID: METHOD_ID,
    access: Redacted.make(decoded.access_token),
    refresh: Redacted.make(decoded.refresh_token),
    expires: now + decoded.expires_in * 1_000,
    metadata,
  } satisfies Credential.OAuth;
});

/**
 * Codex / ChatGPT browser OAuth. `auto` binds loopback and races paste;
 * `paste` skips the listener (SSH). Both advertise the registered redirect URI.
 * Device/headless mode is `loginCodexDevice`.
 */
export const loginCodex = (
  ctl: OAuthFlowController,
  options: CodexLoginMode | (CodexEndpoints & { readonly mode?: CodexLoginMode }) = "auto",
): Effect.Effect<Credential.OAuth, OAuthError> => {
  const opts = typeof options === "string" ? { mode: options } : options;
  const mode = opts.mode ?? "auto";
  if (mode === "device") return loginCodexDevice(ctl, opts);
  const authorizeUrl = opts.authorizeUrl ?? DEFAULT_AUTHORIZE_URL;
  const tokenUrl = opts.tokenUrl ?? DEFAULT_TOKEN_URL;
  const preferredPort = opts.preferredPort ?? OAUTH_PORT;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  // Registered redirect is fixed at 1455 — port fallback would be rejected by the IdP.
  // preferredPort 0 is test-only: advertise whatever the OS binds.
  const allowPortFallback = opts.allowPortFallback ?? preferredPort === 0;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const registeredRedirect =
    preferredPort === 0 ? undefined : `http://localhost:${preferredPort}${CALLBACK_PATH}`;

  return Effect.gen(function* () {
    const pkce = yield* generatePkce;
    const state = yield* generateState;

    const loopback =
      mode === "auto"
        ? yield* acquireLoopbackCallback(
            registeredRedirect !== undefined
              ? {
                  preferredPort,
                  expectedState: state,
                  path: CALLBACK_PATH,
                  redirectUri: registeredRedirect,
                  allowPortFallback,
                  timeoutMs,
                }
              : {
                  preferredPort,
                  expectedState: state,
                  path: CALLBACK_PATH,
                  allowPortFallback,
                  timeoutMs,
                },
          )
        : undefined;

    const redirectUri =
      loopback?.redirectUri ??
      registeredRedirect ??
      `http://localhost:${OAUTH_PORT}${CALLBACK_PATH}`;
    const authUrl = buildAuthorizeUrl({
      authorizeUrl,
      redirectUri,
      challenge: pkce.challenge,
      state,
    });
    loopback?.setAuthUrl(authUrl);

    yield* ctl.onAuth({
      url: authUrl,
      launchUrl: loopback?.launchUrl,
      instructions:
        mode === "paste"
          ? "Open the URL, then paste the redirect URL or code here"
          : "Complete login in the browser (or paste the redirect URL)",
    });
    yield* ctl.onProgress(
      mode === "paste"
        ? "Waiting for pasted authorization code…"
        : "Waiting for browser authentication…",
    );

    const callback = yield* awaitAuthorizationCode({
      ctl,
      expectedState: state,
      loopback,
    });

    yield* ctl.onProgress("Exchanging authorization code for tokens…");
    return yield* exchangeCode({
      tokenUrl,
      code: callback.code,
      redirectUri,
      verifier: pkce.verifier,
      fetch: fetchImpl,
    });
  }).pipe(Effect.scoped);
};

const parseDeviceIntervalSeconds = (raw: string | number | undefined): number => {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 5;
};

/**
 * ChatGPT device-code / headless OAuth.
 * Borrow: OpenCode `plugin/codex.ts` headless + Codex `device_code_auth.rs`.
 * Poll via `pollDeviceCodeFlow`; IdP supplies code_verifier (no local PKCE).
 */
export const loginCodexDevice = Effect.fnUntraced(function* (
  ctl: OAuthFlowController,
  endpoints: CodexEndpoints = {},
) {
  const fetchImpl = endpoints.fetch ?? globalThis.fetch;
  const tokenUrl = endpoints.tokenUrl ?? DEFAULT_TOKEN_URL;
  const userCodeUrl = endpoints.deviceUserCodeUrl ?? DEFAULT_DEVICE_USERCODE_URL;
  const deviceTokenUrl = endpoints.deviceTokenUrl ?? DEFAULT_DEVICE_TOKEN_URL;
  const redirectUri = endpoints.deviceRedirectUri ?? DEFAULT_DEVICE_REDIRECT_URI;
  const verificationUrl = endpoints.deviceVerificationUrl ?? DEFAULT_DEVICE_VERIFICATION_URL;
  const expiresInSeconds =
    endpoints.timeoutMs !== undefined
      ? Math.max(0, Math.floor(endpoints.timeoutMs / 1_000))
      : DEVICE_EXPIRES_SECONDS;

  yield* ctl.onProgress("Requesting device authorization…");
  const userCodeBodyJson = yield* S.encodeEffect(S.fromJsonString(DeviceUserCodeRequest))({
    client_id: CLIENT_ID,
  }).pipe(Effect.orDie);
  const userCodeResponse = yield* Effect.tryPromise({
    try: () =>
      fetchImpl(userCodeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: userCodeBodyJson,
      }),
    catch: (cause) =>
      new OAuthFailed({
        message: cause instanceof Error ? cause.message : String(cause),
        kind: "device-auth",
      }),
  });
  if (!userCodeResponse.ok) {
    return yield* new OAuthFailed({
      message:
        userCodeResponse.status === 404
          ? "Device code login is not enabled for this Codex server"
          : `Device code request failed: ${userCodeResponse.status}`,
      kind: "device-auth",
    });
  }
  const userCodeBody = yield* Effect.tryPromise({
    try: () => userCodeResponse.json(),
    catch: () =>
      new OAuthFailed({
        message: "Device usercode response was not JSON",
        kind: "validation",
      }),
  });
  const device = yield* S.decodeUnknownEffect(DeviceUserCodeResponse)(userCodeBody).pipe(
    Effect.mapError(
      (err) =>
        new OAuthFailed({
          message: `Device usercode missing fields: ${String(err)}`,
          kind: "validation",
        }),
    ),
  );
  const intervalSeconds = parseDeviceIntervalSeconds(device.interval);

  yield* ctl.onAuth({
    url: verificationUrl,
    instructions: `Enter code: ${device.user_code}`,
  });
  yield* ctl.onProgress("Waiting for device authorization…");

  const issued = yield* pollDeviceCodeFlow<typeof DeviceCodeSuccess.Type>({
    intervalSeconds,
    expiresInSeconds,
    poll: Effect.gen(function* () {
      const pollBody = yield* S.encodeEffect(S.fromJsonString(DeviceTokenPollRequest))({
        device_auth_id: device.device_auth_id,
        user_code: device.user_code,
      }).pipe(Effect.orDie);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(deviceTokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: pollBody,
          }),
        catch: (cause) =>
          new OAuthFailed({
            message: cause instanceof Error ? cause.message : String(cause),
            kind: "polling",
          }),
      });
      // Codex/OpenCode: 403/404 = still pending; other non-OK = failed.
      if (response.status === 403 || response.status === 404) {
        return { status: "pending" as const };
      }
      if (!response.ok) {
        return {
          status: "failed" as const,
          message: `Device auth failed with status ${response.status}`,
        };
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          new OAuthFailed({
            message: "Device token response was not JSON",
            kind: "validation",
          }),
      });
      const decoded = yield* S.decodeUnknownEffect(DeviceCodeSuccess)(body).pipe(
        Effect.mapError(
          (err) =>
            new OAuthFailed({
              message: `Device token missing fields: ${String(err)}`,
              kind: "validation",
            }),
        ),
      );
      return { status: "complete" as const, value: decoded };
    }),
  });

  yield* ctl.onProgress("Exchanging authorization code for tokens…");
  return yield* exchangeCode({
    tokenUrl,
    code: issued.authorization_code,
    redirectUri,
    verifier: issued.code_verifier,
    fetch: fetchImpl,
  });
});

export const refreshCodex = (
  credential: Credential.OAuth,
  endpoints: CodexEndpoints = {},
): Effect.Effect<Credential.OAuth, OAuthRefreshError> =>
  Effect.gen(function* () {
    const tokenUrl = endpoints.tokenUrl ?? DEFAULT_TOKEN_URL;
    const fetchImpl = endpoints.fetch ?? globalThis.fetch;
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: Redacted.value(credential.refresh),
            client_id: CLIENT_ID,
          }).toString(),
        }),
      catch: (cause) =>
        new OAuthRefreshError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    if (!response.ok) {
      return yield* new OAuthRefreshError({
        message: `Token refresh failed: ${response.status}`,
      });
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new OAuthRefreshError({ message: "Refresh response was not JSON" }),
    });
    const decoded = yield* S.decodeUnknownEffect(TokenResponse)(body).pipe(
      Effect.mapError(
        (err) => new OAuthRefreshError({ message: `Refresh missing fields: ${String(err)}` }),
      ),
    );
    const accountId =
      extractAccountId(decoded.access_token, decoded.id_token) ?? credential.metadata?.accountId;
    const now = yield* Effect.clockWith((c) => c.currentTimeMillis);
    const metadata =
      accountId !== undefined ? { ...credential.metadata, accountId } : { ...credential.metadata };
    return {
      ...credential,
      access: Redacted.make(decoded.access_token),
      refresh: Redacted.make(decoded.refresh_token),
      expires: now + decoded.expires_in * 1_000,
      metadata,
    } satisfies Credential.OAuth;
  });

const oauthMethod = (endpoints: CodexEndpoints = {}): Method => ({
  type: "oauth",
  id: METHOD_ID,
  label: "ChatGPT subscription",
  prompts: [
    {
      type: "select",
      key: "mode",
      message: "OAuth mode",
      options: [
        { label: "Browser (loopback)", value: "auto", hint: "opens localhost callback" },
        { label: "Paste code", value: "paste", hint: "SSH / no local port" },
        { label: "Device code", value: "device", hint: "headless / enter code at IdP" },
      ],
    },
  ],
  login: (ctl, answers) => {
    const mode: CodexLoginMode =
      answers?.mode === "paste" ? "paste" : answers?.mode === "device" ? "device" : "auto";
    return loginCodex(ctl, { ...endpoints, mode });
  },
});

export const openaiCodex = (endpoints: CodexEndpoints = {}): Integration => ({
  id: "openai-codex",
  label: "ChatGPT Codex",
  methods: [oauthMethod(endpoints)],
  env: [],
  aliases: ["chatgpt"],
  refresh: (credential) => refreshCodex(credential, endpoints),
  model: ({ model, transformClient, thinking }) => {
    const reasoning = openAiReasoningConfig(thinking);
    // ChatGPT Codex rejects Responses without an explicit store=false
    // (`{"detail":"Store must be set to false"}`). Platform OpenAI defaults
    // omit it; Codex does not. Borrow: OpenAI Responses `store` on
    // OpenAiLanguageModel.Config; Codex backend enforces the false branch.
    const config = { store: false as const, ...(reasoning ?? {}) };
    return OpenAiLanguageModel.layer({
      model,
      config,
    }).pipe(
      Layer.provide(
        OpenAiClient.layer({
          transformClient,
          apiUrl: CODEX_API_URL,
        }),
      ),
      Layer.provide(FetchHttpClient.layer),
    );
  },
  authorize: (credential, request) => {
    const token =
      credential.type === "oauth"
        ? Redacted.value(credential.access)
        : Redacted.value(credential.key);
    let next = HttpClientRequest.setHeader("Authorization", `Bearer ${token}`)(request);
    // Match OpenCode codex `chat.headers` + Codex default_client originator/UA on API calls.
    next = HttpClientRequest.setHeader("originator", "amux")(next);
    next = HttpClientRequest.setHeader("User-Agent", CODEX_USER_AGENT)(next);
    if (credential.type === "oauth") {
      const accountId = credential.metadata?.accountId;
      if (typeof accountId === "string") {
        next = HttpClientRequest.setHeader("ChatGPT-Account-Id", accountId)(next);
      }
    }
    return next;
  },
});

/** Default integration instance (live IdP endpoints). */
export const openaiCodexIntegration = openaiCodex();
