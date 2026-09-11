import { expect, test } from "bun:test";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import * as os from "node:os";
import { testEffect } from "@danielfgray/amux/testing";
import type { OAuthFlowController } from "../oauth/types.ts";
import {
  authorizeCopilot,
  copilotApiBase,
  GITHUB_COPILOT_CLIENT_ID_CONFIG,
  loginCopilot,
  makeGithubCopilot,
  normalizeDomain,
} from "./index.ts";

const TEST_CLIENT_ID = "amux-test-copilot-client";

const fakeController = (): OAuthFlowController & {
  urls: string[];
  instructions: string[];
} => {
  const urls: string[] = [];
  const instructions: string[] = [];
  return {
    urls,
    instructions,
    onAuth: (info) =>
      Effect.sync(() => {
        urls.push(info.url);
        if (info.instructions !== undefined) instructions.push(info.instructions);
      }),
    onProgress: () => Effect.void,
    onManualCodeInput: Effect.never,
  };
};

test("normalizeDomain strips scheme and trailing slash", () => {
  expect(normalizeDomain("https://company.ghe.com/")).toBe("company.ghe.com");
  expect(normalizeDomain("company.ghe.com")).toBe("company.ghe.com");
});

test("copilotApiBase picks public vs enterprise host", () => {
  expect(copilotApiBase()).toBe("https://api.githubcopilot.com");
  expect(copilotApiBase("company.ghe.com")).toBe("https://copilot-api.company.ghe.com");
});

test("authorizeCopilot stamps Copilot headers and strips x-api-key", () => {
  const request = authorizeCopilot(
    {
      type: "oauth",
      methodID: "github-copilot",
      access: Redacted.make("gh-token"),
      refresh: Redacted.make("gh-token"),
      expires: 0,
    },
    HttpClientRequest.get("https://api.githubcopilot.com/v1/chat/completions").pipe(
      HttpClientRequest.setHeader("x-api-key", "should-go"),
    ),
  );
  expect(request.headers.authorization).toBe("Bearer gh-token");
  expect(request.headers["openai-intent"]).toBe("conversation-edits");
  expect(request.headers["x-initiator"]).toBe("agent");
  expect(request.headers["x-github-api-version"]).toBe("2022-11-28");
  expect(request.headers["user-agent"]).toBe(
    `amux/0.1.0 (${os.platform()} ${os.release()}; ${os.arch()})`,
  );
  expect(request.headers["x-api-key"]).toBeUndefined();
});

test("authorizeCopilot rewrites enterprise API host", () => {
  const request = authorizeCopilot(
    {
      type: "oauth",
      methodID: "github-copilot",
      access: Redacted.make("tok"),
      refresh: Redacted.make("tok"),
      expires: 0,
      metadata: { enterpriseUrl: "acme.ghe.com" },
    },
    HttpClientRequest.get("https://api.githubcopilot.com/chat/completions"),
  );
  expect(request.url).toBe("https://copilot-api.acme.ghe.com/chat/completions");
});

testEffect("Copilot device login: fake GitHub IdP pending → token", () =>
  Effect.gen(function* () {
    let polls = 0;
    const idp: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      fetch(req): Response {
        const path = new URL(req.url).pathname;
        if (path === "/login/device/code") {
          return Response.json({
            device_code: "dc-1",
            user_code: "WDJB-MJHT",
            verification_uri: `http://127.0.0.1:${idp.port}/login/device`,
            interval: 1,
            expires_in: 60,
          });
        }
        if (path === "/login/oauth/access_token") {
          polls += 1;
          if (polls < 2) {
            return Response.json({ error: "authorization_pending" });
          }
          return Response.json({ access_token: "ghu_test_token" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.resolve(idp.stop(true))).pipe(Effect.asVoid),
    );

    const base = `http://127.0.0.1:${idp.port}`;
    const ctl = fakeController();
    const credential = yield* loginCopilot(
      ctl,
      { deploymentType: "github.com" },
      {
        clientId: TEST_CLIENT_ID,
        deviceCodeUrl: `${base}/login/device/code`,
        accessTokenUrl: `${base}/login/oauth/access_token`,
        timeoutMs: 30_000,
        pollSafetySeconds: 0,
      },
    );

    expect(ctl.urls[0]).toBe(`${base}/login/device`);
    expect(ctl.instructions[0]).toBe("Enter code: WDJB-MJHT");
    expect(Redacted.value(credential.access)).toBe("ghu_test_token");
    expect(Redacted.value(credential.refresh)).toBe("ghu_test_token");
    expect(credential.expires).toBe(0);
    expect(credential.metadata).toBeUndefined();
    expect(polls).toBeGreaterThanOrEqual(2);
  }).pipe(Effect.scoped),
);

testEffect("Copilot enterprise login stores enterpriseUrl metadata", () =>
  Effect.gen(function* () {
    const idp = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/login/device/code") {
          return Response.json({
            device_code: "dc-e",
            user_code: "ENTR-PRIS",
            verification_uri: "https://acme.ghe.com/login/device",
            interval: 1,
          });
        }
        if (path === "/login/oauth/access_token") {
          return Response.json({ access_token: "ghu_ent" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.resolve(idp.stop(true))).pipe(Effect.asVoid),
    );
    const base = `http://127.0.0.1:${idp.port}`;
    const credential = yield* loginCopilot(
      fakeController(),
      { deploymentType: "enterprise", enterpriseUrl: "https://acme.ghe.com/" },
      {
        clientId: TEST_CLIENT_ID,
        deviceCodeUrl: `${base}/login/device/code`,
        accessTokenUrl: `${base}/login/oauth/access_token`,
        timeoutMs: 15_000,
        pollSafetySeconds: 0,
      },
    );
    expect(credential.metadata?.enterpriseUrl).toBe("acme.ghe.com");
  }).pipe(Effect.scoped),
);

testEffect("Copilot login fails until AMUX_GITHUB_COPILOT_CLIENT_ID is set", () =>
  Effect.gen(function* () {
    const result = yield* loginCopilot(fakeController(), {}, {}).pipe(Effect.flip);
    expect(result._tag).toBe("OAuthFailed");
    expect(result.message).toContain(GITHUB_COPILOT_CLIENT_ID_CONFIG);
  }).pipe(
    Effect.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))),
  ),
);

testEffect("Copilot login reads client id from Config", () =>
  Effect.gen(function* () {
    let seenClientId: string | undefined;
    const idp = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/login/device/code") {
          return req.json().then((body) => {
            seenClientId =
              body !== null &&
              typeof body === "object" &&
              "client_id" in body &&
              typeof body.client_id === "string"
                ? body.client_id
                : undefined;
            return Response.json({
              device_code: "dc-cfg",
              user_code: "CFG-CODE",
              verification_uri: "https://github.com/login/device",
              interval: 1,
            });
          });
        }
        if (path === "/login/oauth/access_token") {
          return Response.json({ access_token: "ghu_cfg" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.resolve(idp.stop(true))).pipe(Effect.asVoid),
    );
    const base = `http://127.0.0.1:${idp.port}`;
    const credential = yield* loginCopilot(
      fakeController(),
      { deploymentType: "github.com" },
      {
        deviceCodeUrl: `${base}/login/device/code`,
        accessTokenUrl: `${base}/login/oauth/access_token`,
        timeoutMs: 15_000,
        pollSafetySeconds: 0,
      },
    );
    expect(seenClientId).toBe("from-config-client");
    expect(Redacted.value(credential.access)).toBe("ghu_cfg");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          [GITHUB_COPILOT_CLIENT_ID_CONFIG]: "from-config-client",
        }),
      ),
    ),
  ),
);

test("github-copilot integration exposes oauth without a mode select", () => {
  const integration = makeGithubCopilot();
  expect(integration.id).toBe("github-copilot");
  const method = integration.methods[0];
  expect(method?.type).toBe("oauth");
  if (method?.type !== "oauth") return;
  expect(method.prompts?.some((p) => p.type === "select" && p.key === "mode")).toBe(false);
  expect(method.prompts?.some((p) => p.type === "select" && p.key === "deploymentType")).toBe(true);
});
