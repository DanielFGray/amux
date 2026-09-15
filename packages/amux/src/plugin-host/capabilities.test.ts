/** @effect-diagnostics *:skip-file -- drives real sockets for capability RPC. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Path, Ref, Result, Schema as S, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import {
  DaemonSessions,
  DaemonSessionsError,
  type DaemonSessionsService,
} from "../daemon-sessions.ts";
import { startDaemon } from "../daemon.ts";
import { controlCall } from "../control-client.ts";
import { admitsHostChild } from "../peer-credentials.ts";
import { SessionStore } from "../session.ts";
import { registerCleanup, tempDir } from "../test-tmp.ts";
import { waitFor } from "../test-wait.ts";
import { serveDaemonSessions } from "./capabilities-server.ts";
import { daemonSessionsFromCapabilitiesSocket } from "./daemon-sessions-layer.ts";
import { OwnerJsonText } from "../layout.ts";

registerCleanup();

const messageText = (value: typeof OwnerJsonText.Encoded) => S.decodeSync(OwnerJsonText)(value);
const captureFixture = fileURLToPath(new URL("./capture-fixture.ts", import.meta.url));

const provideEnv = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  e: NodeJS.ProcessEnv,
): Effect.Effect<A, E, Exclude<R, SessionStore | FileSystem.FileSystem | Path.Path>> =>
  effect.pipe(
    Effect.provide(
      SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(e)),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path | Scope.Scope>,
  e: NodeJS.ProcessEnv,
) => Effect.runPromise(Effect.scoped(provideEnv(effect, e)));

const trackingService = (state: Ref.Ref<Tracked>): DaemonSessionsService => ({
  message: (id, message) =>
    Ref.get(state).pipe(
      Effect.flatMap((s) =>
        s.failNext !== undefined
          ? Effect.fail(new DaemonSessionsError({ message: s.failNext }))
          : Ref.update(state, (cur) => ({
              ...cur,
              messages: [...cur.messages, { id, message }],
            })),
      ),
    ),
  prompt: (target, text, options) =>
    Ref.get(state).pipe(
      Effect.flatMap((s) =>
        s.failNext !== undefined
          ? Effect.fail(new DaemonSessionsError({ message: s.failNext }))
          : Ref.update(state, (cur) => ({
              ...cur,
              prompted: [...cur.prompted, { target, text, options }],
            })),
      ),
    ),
  capture: (session) =>
    Ref.get(state).pipe(
      Effect.flatMap((s) =>
        s.failNext !== undefined
          ? Effect.fail(new DaemonSessionsError({ message: s.failNext }))
          : Ref.update(state, (cur) => ({
              ...cur,
              captured: [...cur.captured, session],
            })).pipe(Effect.as(`captured:${session}`)),
      ),
    ),
});

type Tracked = {
  messages: { id: string; message: unknown }[];
  prompted: { target: string; text: string; options: unknown }[];
  captured: string[];
  failNext?: string;
};

const admitSelf = (peer: Parameters<typeof admitsHostChild>[0]) =>
  Effect.succeed(admitsHostChild(peer, process.getuid?.(), process.pid));

test("capability client round-trips message, prompt, capture, and typed errors", async () => {
  const dir = tempDir("capabilities-rt");
  const socket = join(dir, "capabilities.sock");
  const state = await Effect.runPromise(
    Ref.make<Tracked>({
      messages: [],
      prompted: [],
      captured: [],
    }),
  );
  const service = trackingService(state);

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveDaemonSessions(socket, service, admitSelf);

        const sessionsLayer = daemonSessionsFromCapabilitiesSocket(socket);

        yield* Effect.gen(function* () {
          const sessions = yield* DaemonSessions;
          const ping = messageText({ kind: "ping", n: 1 });
          yield* sessions.message("s1", ping);
          yield* sessions.prompt("s1", "hello", { delivery: "steer" });
          const captured = yield* sessions.capture("s1");
          expect(captured).toBe("captured:s1");
        }).pipe(Effect.provide(sessionsLayer));

        const tracked = yield* Ref.get(state);
        expect(tracked.messages).toEqual([
          { id: "s1", message: messageText({ kind: "ping", n: 1 }) },
        ]);
        expect(tracked.prompted).toEqual([
          { target: "s1", text: "hello", options: { delivery: "steer" } },
        ]);
        expect(tracked.captured).toEqual(["s1"]);

        yield* Ref.update(state, (s) => ({ ...s, failNext: "boom" }));
        const asError = yield* Effect.gen(function* () {
          const sessions = yield* DaemonSessions;
          return yield* sessions.capture("s2").pipe(Effect.result);
        }).pipe(Effect.provide(sessionsLayer));
        expect(Result.isFailure(asError)).toBe(true);
        if (Result.isFailure(asError)) {
          expect(S.is(DaemonSessionsError)(asError.failure)).toBe(true);
          expect(asError.failure.message).toBe("boom");
        }
      }).pipe(Effect.provide(BunFileSystem.layer)),
    ),
  );
}, 15_000);

test("capability socket refuses a peer whose pid is not admitted", async () => {
  const dir = tempDir("capabilities-refuse");
  const socket = join(dir, "capabilities.sock");
  let called = 0;
  const service: DaemonSessionsService = {
    message: () =>
      Effect.sync(() => {
        called += 1;
      }),
    prompt: () =>
      Effect.sync(() => {
        called += 1;
      }),
    capture: () =>
      Effect.sync(() => {
        called += 1;
        return "nope";
      }),
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveDaemonSessions(socket, service, (peer) =>
          Effect.succeed(admitsHostChild(peer, process.getuid?.(), process.pid + 1_000_000)),
        );

        const sessionsLayer = daemonSessionsFromCapabilitiesSocket(socket);

        const result = yield* Effect.gen(function* () {
          const sessions = yield* DaemonSessions;
          return yield* sessions.capture("s1").pipe(Effect.result);
        }).pipe(Effect.provide(sessionsLayer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(S.is(DaemonSessionsError)(result.failure)).toBe(true);
          expect(result.failure.message).toContain("plugin capabilities socket");
        }
        expect(called).toBe(0);
      }).pipe(Effect.provide(BunFileSystem.layer)),
    ),
  );
}, 15_000);

test("capability layer opens one connection for concurrent first calls", async () => {
  const dir = tempDir("capabilities-once");
  const socket = join(dir, "capabilities.sock");
  const admitted = await Effect.runPromise(Ref.make(0));
  const service: DaemonSessionsService = {
    message: () => Effect.void,
    prompt: () => Effect.void,
    capture: (session) => Effect.succeed(`captured:${session}`),
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveDaemonSessions(socket, service, (peer) =>
          Effect.gen(function* () {
            const ok = admitsHostChild(peer, process.getuid?.(), process.pid);
            if (ok) yield* Ref.update(admitted, (n) => n + 1);
            return ok;
          }),
        );

        const sessionsLayer = daemonSessionsFromCapabilitiesSocket(socket);
        yield* Effect.gen(function* () {
          const sessions = yield* DaemonSessions;
          yield* Effect.all([sessions.capture("a"), sessions.capture("b")], {
            concurrency: 2,
          });
        }).pipe(Effect.provide(sessionsLayer));

        expect(yield* Ref.get(admitted)).toBe(1);
      }).pipe(Effect.provide(BunFileSystem.layer)),
    ),
  );
}, 15_000);

test("plugin-host capture fixture reads a live session through DaemonSessions", async () => {
  const home = tempDir("capabilities-e2e");
  const outPath = join(home, "capture.txt");
  const e = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
  };

  const daemon = await run(
    startDaemon("cap-e2e", {
      pluginHost: {
        pingIntervalMs: 200,
        pingTimeoutMs: 500,
        backoffInitialMs: 50,
        backoffMaxMs: 200,
        argv: [process.execPath, captureFixture, outPath, "cap-session", "hello-from-pty"],
      },
    }),
    e,
  );

  try {
    await waitFor(
      async () => {
        const report = await run(
          controlCall(daemon.id, (c) => c.Status()),
          e,
        );
        return report.pluginHost.state === "ready";
      },
      "plugin-host ready for capture",
      15_000,
    );

    await run(
      daemon.spawnSession({
        id: "cap-session",
        cmd: ["sh", "-c", "printf 'hello-from-pty'; sleep 30"],
        cols: 80,
        rows: 24,
      }),
      e,
    );

    await waitFor(
      async () => Bun.file(outPath).exists(),
      "capture fixture to write output",
      25_000,
    );

    const text = await Bun.file(outPath).text();
    expect(text).toContain("hello-from-pty");
  } finally {
    await Effect.runPromise(daemon.stop);
  }
}, 40_000);
