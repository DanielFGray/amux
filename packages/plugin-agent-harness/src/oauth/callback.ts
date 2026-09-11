/**
 * Loopback OAuth callback listener, Scope-bound so cancel closes the socket.
 * Borrow: oh-my-pi callback-server + opencode `plugin/codex.ts` createServer.
 *
 * Uses Bun.serve (same as harness integration tests' fake gateway). Provider
 * endpoints stay out of this module — only bind + parse + Deferred.
 *
 * Caller must run the login Effect under `Effect.scoped` so the finalizer
 * stops the server when the Scope closes (success, failure, or interrupt).
 */
import { Deferred, Duration, Effect, Option, Schema as S, type Scope } from "effect";
import { OAuthCancelled, OAuthFailed, OAuthPortInUse, OAuthTimeout } from "./types.ts";

const DEFAULT_PATH = "/auth/callback";
const DEFAULT_HOSTNAME = "localhost";
const DEFAULT_TIMEOUT_MS = 300_000;
const LAUNCH_PATH = "/launch";

export type CallbackResult = {
  readonly code: string;
  readonly state: string;
};

export type LoopbackOptions = {
  readonly preferredPort: number;
  readonly expectedState: string;
  readonly path?: string;
  readonly hostname?: string;
  /** Exact redirect URI advertised to the IdP; disables port fallback. */
  readonly redirectUri?: string;
  /** When preferredPort is busy, bind port 0. Default true. */
  readonly allowPortFallback?: boolean;
  readonly timeoutMs?: number;
};

export type LoopbackCallback = {
  readonly port: number;
  readonly redirectUri: string;
  readonly launchUrl: string | undefined;
  /** Publish the authorize URL so GET /launch can 302 to it. */
  readonly setAuthUrl: (url: string | undefined) => void;
  readonly awaitCode: Effect.Effect<CallbackResult, OAuthFailed | OAuthCancelled | OAuthTimeout>;
};

const SUCCESS_HTML = `<!doctype html><html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#131010;color:#f1ecec"><div style="text-align:center"><h1>Authorization Successful</h1><p>You can close this window.</p></div><script>setTimeout(()=>window.close(),2000)</script></body></html>`;

const errorHtml = (message: string) =>
  `<!doctype html><html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#131010;color:#f1ecec"><div style="text-align:center"><h1>Authorization Failed</h1><p>${message}</p></div></body></html>`;

const isAddressInUse = (error: Error | { readonly code?: string }): boolean => {
  if ("code" in error && typeof error.code === "string") return error.code === "EADDRINUSE";
  return error instanceof Error && /EADDRINUSE|in use/i.test(error.message);
};

type Serving = {
  readonly port: number;
  readonly stop: (closeActiveConnections?: boolean) => void;
};

const bindServer = (
  port: number,
  path: string,
  expectedState: string,
  deferred: Deferred.Deferred<CallbackResult, OAuthFailed | OAuthCancelled>,
  getAuthUrl: () => string | undefined,
): Serving => {
  const settle = (effect: Effect.Effect<boolean>) => {
    void Effect.runPromise(effect);
  };

  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === LAUNCH_PATH) {
          const authUrl = getAuthUrl();
          if (!authUrl) {
            return new Response("Authorization URL not ready", { status: 503 });
          }
          return Response.redirect(authUrl, 302);
        }
        if (url.pathname !== path) {
          return new Response("Not found", { status: 404 });
        }

        const error = url.searchParams.get("error");
        if (error) {
          const description = url.searchParams.get("error_description") || error;
          settle(
            Deferred.fail(
              deferred,
              new OAuthFailed({
                message: `Authorization failed: ${description}`,
                kind: "device-auth",
              }),
            ),
          );
          return new Response(errorHtml(description), {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? "";
        if (!code) {
          settle(
            Deferred.fail(
              deferred,
              new OAuthFailed({ message: "Missing authorization code", kind: "validation" }),
            ),
          );
          return new Response(errorHtml("Missing authorization code"), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }
        if (state !== expectedState) {
          settle(
            Deferred.fail(
              deferred,
              new OAuthFailed({ message: "Invalid state — possible CSRF", kind: "csrf" }),
            ),
          );
          return new Response(errorHtml("Invalid state"), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }

        settle(Deferred.succeed(deferred, { code, state }));
        return new Response(SUCCESS_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    return {
      port: server.port ?? port,
      stop: (close) => {
        server.stop(close);
      },
    };
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    if (isAddressInUse(cause)) {
      throw new OAuthPortInUse({
        port,
        message: `OAuth callback port ${port} is in use`,
      });
    }
    throw cause;
  }
};

/**
 * Acquire a loopback listener into the current Scope.
 */
export const acquireLoopbackCallback = (
  options: LoopbackOptions,
): Effect.Effect<LoopbackCallback, OAuthPortInUse | OAuthFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const path = options.path ?? DEFAULT_PATH;
    const hostname = options.hostname ?? DEFAULT_HOSTNAME;
    const allowFallback = options.allowPortFallback ?? true;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deferred = yield* Deferred.make<CallbackResult, OAuthFailed | OAuthCancelled>();

    let authUrl: string | undefined;
    const getAuthUrl = () => authUrl;

    const start = (port: number) =>
      Effect.try({
        try: () => bindServer(port, path, options.expectedState, deferred, getAuthUrl),
        catch: (cause) =>
          S.is(OAuthPortInUse)(cause)
            ? cause
            : new OAuthFailed({
                message: cause instanceof Error ? cause.message : String(cause),
                kind: "port",
              }),
      });

    const server = yield* start(options.preferredPort).pipe(
      Effect.catchTag("OAuthPortInUse", (err) => {
        if (options.redirectUri !== undefined || !allowFallback) {
          return Effect.fail(err);
        }
        return start(0);
      }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.stop(true);
      }),
    );

    const port = server.port;
    const redirectUri = options.redirectUri ?? `http://${hostname}:${port}${path}`;
    const launchUrl = path === LAUNCH_PATH ? undefined : `http://${hostname}:${port}${LAUNCH_PATH}`;

    const awaitCode = Deferred.await(deferred).pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new OAuthTimeout({ message: `OAuth callback timed out after ${timeoutMs}ms` }),
            ),
          onSome: (result) => Effect.succeed(result),
        }),
      ),
    );

    return {
      port,
      redirectUri,
      launchUrl,
      setAuthUrl: (url: string | undefined) => {
        authUrl = url;
      },
      awaitCode,
    } satisfies LoopbackCallback;
  });
