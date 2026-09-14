/**
 * GitHub Copilot OAuth adapter — device-code on oauth/pollDeviceCodeFlow.
 * Borrow: OpenCode `plugin/github-copilot/copilot.ts`, oh-my-pi
 * `registry/oauth/github-copilot.ts` (flow only — not their OAuth App id).
 *
 * Provider-local: github.com / enterprise device URLs, Copilot API host +
 * headers. Client id comes from Config (`AMUX_GITHUB_COPILOT_CLIENT_ID`) —
 * amux must register its own GitHub OAuth App; we do not ship OpenCode's.
 */
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Config, Effect, Option, Redacted, Schema as S } from "effect";
import * as os from "node:os";
import type { Credential } from "../credential.ts";
import { pollDeviceCodeFlow, type OAuthFlowController, OAuthFailed } from "../oauth/index.ts";
import { openAiCompatible } from "./openai-compatible.ts";
import type { Integration, Method } from "./types.ts";

/** Effect Config / env key for the amux-registered GitHub OAuth App client id. */
export const GITHUB_COPILOT_CLIENT_ID_CONFIG = "AMUX_GITHUB_COPILOT_CLIENT_ID";
const SCOPE = "read:user";
const METHOD_ID = "github-copilot";
const DEFAULT_DOMAIN = "github.com";
const DEFAULT_API = "https://api.githubcopilot.com";
/** OpenCode polling clock-skew margin (RFC 8628 interval + buffer). */
const POLL_SAFETY_SECONDS = 3;
const DEVICE_EXPIRES_SECONDS = 15 * 60;
const GITHUB_API_VERSION = "2022-11-28";
const AMUX_VERSION = "0.1.0";
const USER_AGENT = `amux/${AMUX_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`;
const MISSING_CLIENT_ID = `GitHub Copilot OAuth client id not configured. Set ${GITHUB_COPILOT_CLIENT_ID_CONFIG} to an amux-registered GitHub OAuth App client id.`;

const DeviceCodeResponse = S.Struct({
  device_code: S.String,
  user_code: S.String,
  verification_uri: S.String,
  interval: S.optional(S.Union([S.String, S.Finite])),
  expires_in: S.optional(S.Union([S.String, S.Finite])),
});

const AccessTokenSuccess = S.Struct({
  access_token: S.String,
});

const AccessTokenPending = S.Struct({
  error: S.String,
  interval: S.optional(S.Union([S.String, S.Finite])),
});

const DeviceCodeRequest = S.Struct({
  client_id: S.String,
  scope: S.String,
});

const DeviceTokenPollRequest = S.Struct({
  client_id: S.String,
  device_code: S.String,
  grant_type: S.String,
});

export type CopilotEndpoints = {
  readonly deviceCodeUrl?: string;
  readonly accessTokenUrl?: string;
  readonly timeoutMs?: number;
  /** Extra seconds added to the IdP interval (OpenCode uses 3). Tests may pass 0. */
  readonly pollSafetySeconds?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Test / override; production reads `AMUX_GITHUB_COPILOT_CLIENT_ID`. */
  readonly clientId?: string;
};

const resolveClientId = Effect.fnUntraced(function* (endpoints: CopilotEndpoints) {
  if (endpoints.clientId !== undefined && endpoints.clientId.length > 0) {
    return endpoints.clientId;
  }
  const configured = yield* Config.option(Config.string(GITHUB_COPILOT_CLIENT_ID_CONFIG)).pipe(
    Effect.mapError(
      () =>
        new OAuthFailed({
          message: MISSING_CLIENT_ID,
          kind: "device-auth",
        }),
    ),
  );
  return yield* Option.match(configured, {
    onNone: () =>
      new OAuthFailed({
        message: MISSING_CLIENT_ID,
        kind: "device-auth",
      }),
    onSome: (id) =>
      id.length > 0
        ? Effect.succeed(id)
        : new OAuthFailed({
            message: MISSING_CLIENT_ID,
            kind: "device-auth",
          }),
  });
});

export const normalizeDomain = (url: string): string =>
  url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export const copilotApiBase = (enterpriseUrl?: string): string =>
  enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : DEFAULT_API;

const deviceUrls = (domain: string) => ({
  deviceCodeUrl: `https://${domain}/login/device/code`,
  accessTokenUrl: `https://${domain}/login/oauth/access_token`,
});

const parsePositiveSeconds = (raw: string | number | undefined, fallback: number): number => {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
};

/**
 * GitHub Copilot device-code login.
 * Borrow: OpenCode copilot authorize flow — grant_type device_code,
 * access_token stored as both access+refresh with expires 0.
 * Client id: Config `AMUX_GITHUB_COPILOT_CLIENT_ID` (or endpoints.clientId).
 */
export const loginCopilot = Effect.fnUntraced(function* (
  ctl: OAuthFlowController,
  answers: Readonly<Record<string, string>> = {},
  endpoints: CopilotEndpoints = {},
) {
  const clientId = yield* resolveClientId(endpoints);
  const fetchImpl = endpoints.fetch ?? globalThis.fetch;
  const deploymentType = answers.deploymentType ?? "github.com";
  const domain =
    deploymentType === "enterprise" && answers.enterpriseUrl
      ? normalizeDomain(answers.enterpriseUrl)
      : DEFAULT_DOMAIN;
  const urls = deviceUrls(domain);
  const deviceCodeUrl = endpoints.deviceCodeUrl ?? urls.deviceCodeUrl;
  const accessTokenUrl = endpoints.accessTokenUrl ?? urls.accessTokenUrl;
  const expiresInSeconds =
    endpoints.timeoutMs !== undefined
      ? Math.max(0, Math.floor(endpoints.timeoutMs / 1_000))
      : DEVICE_EXPIRES_SECONDS;

  yield* ctl.onProgress("Requesting device authorization…");
  const deviceCodeBody = yield* S.encodeEffect(S.fromJsonString(DeviceCodeRequest))({
    client_id: clientId,
    scope: SCOPE,
  }).pipe(Effect.orDie);
  const deviceResponse = yield* Effect.tryPromise({
    try: () =>
      fetchImpl(deviceCodeUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: deviceCodeBody,
      }),
    catch: (cause) =>
      new OAuthFailed({
        message: cause instanceof Error ? cause.message : String(cause),
        kind: "device-auth",
      }),
  });
  if (!deviceResponse.ok) {
    return yield* new OAuthFailed({
      message: `Device code request failed: ${deviceResponse.status}`,
      kind: "device-auth",
    });
  }
  const deviceBody = yield* Effect.tryPromise({
    try: () => deviceResponse.json(),
    catch: () =>
      new OAuthFailed({
        message: "Device code response was not JSON",
        kind: "validation",
      }),
  });
  const device = yield* S.decodeUnknownEffect(DeviceCodeResponse)(deviceBody).pipe(
    Effect.mapError(
      (err) =>
        new OAuthFailed({
          message: `Device code missing fields: ${String(err)}`,
          kind: "validation",
        }),
    ),
  );
  const intervalSeconds =
    parsePositiveSeconds(device.interval, 5) + (endpoints.pollSafetySeconds ?? POLL_SAFETY_SECONDS);

  yield* ctl.onAuth({
    url: device.verification_uri,
    instructions: `Enter code: ${device.user_code}`,
  });
  yield* ctl.onProgress("Waiting for device authorization…");

  const token = yield* pollDeviceCodeFlow<typeof AccessTokenSuccess.Type>({
    intervalSeconds,
    expiresInSeconds: parsePositiveSeconds(device.expires_in, expiresInSeconds),
    poll: Effect.gen(function* () {
      const pollBody = yield* S.encodeEffect(S.fromJsonString(DeviceTokenPollRequest))({
        client_id: clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).pipe(Effect.orDie);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(accessTokenUrl, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "User-Agent": USER_AGENT,
            },
            body: pollBody,
          }),
        catch: (cause) =>
          new OAuthFailed({
            message: cause instanceof Error ? cause.message : String(cause),
            kind: "polling",
          }),
      });
      if (!response.ok) {
        return {
          status: "failed" as const,
          message: `Device token poll failed: ${response.status}`,
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
      const asSuccess = S.decodeUnknownOption(AccessTokenSuccess)(body);
      if (Option.isSome(asSuccess)) {
        return { status: "complete" as const, value: asSuccess.value };
      }
      const pending = S.decodeUnknownOption(AccessTokenPending)(body);
      if (Option.isSome(pending)) {
        if (pending.value.error === "authorization_pending") {
          return { status: "pending" as const };
        }
        if (pending.value.error === "slow_down") {
          return { status: "slow_down" as const };
        }
        return {
          status: "failed" as const,
          message: `Device auth failed: ${pending.value.error}`,
        };
      }
      return {
        status: "failed" as const,
        message: "Device token response missing access_token",
      };
    }),
  });

  return {
    type: "oauth" as const,
    methodID: METHOD_ID,
    // OpenCode stores the GitHub grant in both fields with expires: 0 —
    // there is no separate Copilot exchange / refresh for this grant.
    access: Redacted.make(token.access_token),
    refresh: Redacted.make(token.access_token),
    expires: 0,
    metadata: deploymentType === "enterprise" ? { enterpriseUrl: domain } : undefined,
  } satisfies Credential.OAuth;
});

const oauthMethod = (endpoints: CopilotEndpoints = {}): Method => ({
  type: "oauth",
  id: METHOD_ID,
  label: "Login with GitHub Copilot",
  prompts: [
    {
      type: "select",
      key: "deploymentType",
      message: "GitHub deployment",
      options: [
        { label: "GitHub.com", value: "github.com", hint: "Public" },
        {
          label: "GitHub Enterprise",
          value: "enterprise",
          hint: "Data residency or self-hosted",
        },
      ],
    },
    {
      type: "text",
      key: "enterpriseUrl",
      message: "GitHub Enterprise URL or domain",
      placeholder: "company.ghe.com",
      when: { key: "deploymentType", op: "eq", value: "enterprise" },
    },
  ],
  login: (ctl, answers) => loginCopilot(ctl, answers ?? {}, endpoints),
});

/**
 * Copilot headers on every request. Borrow: OpenCode copilot fetch rewrite —
 * Bearer GitHub token, Openai-Intent, x-initiator, strip x-api-key.
 */
export const authorizeCopilot = (
  credential: Credential.Value,
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const token =
    credential.type === "oauth"
      ? Redacted.value(credential.access)
      : Redacted.value(credential.key);
  let next = HttpClientRequest.setHeader("Authorization", `Bearer ${token}`)(request);
  next = HttpClientRequest.setHeader("User-Agent", USER_AGENT)(next);
  next = HttpClientRequest.setHeader("Openai-Intent", "conversation-edits")(next);
  next = HttpClientRequest.setHeader("x-initiator", "agent")(next);
  next = HttpClientRequest.setHeader("X-GitHub-Api-Version", GITHUB_API_VERSION)(next);
  next = HttpClientRequest.removeHeader("x-api-key")(next);
  if (credential.type === "oauth") {
    const enterpriseUrl = credential.metadata?.enterpriseUrl;
    if (enterpriseUrl !== undefined && enterpriseUrl.length > 0) {
      try {
        const current = new URL(request.url);
        const target = new URL(copilotApiBase(enterpriseUrl));
        target.pathname = current.pathname;
        target.search = current.search;
        next = HttpClientRequest.setUrl(target.toString())(next);
      } catch {
        /* keep catalog host */
      }
    }
  }
  return next;
};

export const githubCopilot = (endpoints: CopilotEndpoints = {}): Integration => {
  const base = openAiCompatible({
    id: "github-copilot",
    label: "GitHub Copilot",
    env: "GITHUB_TOKEN",
    methods: [oauthMethod(endpoints)],
  });
  return {
    ...base,
    // Catalog already names github-copilot; no aliases.
    model: (request) =>
      base.model({
        ...request,
        // Prefer catalog api; enterprise host rewrite happens in authorize.
        apiUrl: request.apiUrl ?? DEFAULT_API,
      }),
    authorize: authorizeCopilot,
  };
};

export const githubCopilotIntegration = githubCopilot();
