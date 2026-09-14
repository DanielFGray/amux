/** @effect-diagnostics *:skip-file -- plain-async by design: real OS boundary (daemon subprocess + PTY) this suite deliberately drives unmocked. */
/**
 * Out-of-process attach: a daemon started on demand keeps agents across
 * separate client processes. Moved from attachclient.test.ts (slow lane).
 */
import { afterEach, expect } from "bun:test";
import {
  Config,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Option,
  Path,
  Scope,
} from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { SessionHandle } from "../packages/amux/src/session-handle.ts";
import { SessionClient, type SessionClientContract } from "../packages/amux/src/client.ts";
import { captureVisible } from "../packages/amux/src/capture.ts";
import { processAlive, SessionStore } from "../packages/amux/src/session.ts";
import { registerCleanup, tempDir } from "../packages/amux/src/test-tmp.ts";
import { testEffect } from "../packages/amux/src/test-effect.ts";
import { until } from "../packages/amux/src/test-wait.ts";

registerCleanup();

const join = (...paths: string[]) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.join(...paths)).pipe(Effect.provide(Path.layer)),
  );

const scopes: Scope.Closeable[] = [];
const sessions: SessionHandle[] = [];

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path>,
  env: NodeJS.ProcessEnv,
) =>
  effect.pipe(
    Effect.provide(
      SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );

const connect = Effect.fnUntraced(function* (
  id: string,
  env: NodeJS.ProcessEnv,
  options: { client?: string; autostart?: boolean } = {},
) {
  const scope = yield* Scope.make();
  scopes.push(scope);
  return yield* run(Scope.provide(SessionClient.connect(id, options), scope), env);
});

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const session of sessions.splice(0)) session.dispose();
      for (const scope of scopes.splice(0))
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }),
  ),
);

type ModeledAgent = {
  id: string;
  cmd: string[];
  cwd?: string;
  cols: number;
  rows: number;
};

function modeledAgent(client: SessionClientContract): ModeledAgent {
  const session = client
    .workspace()
    .spaces[0]?.windows[0]?.sessions.find((candidate) => !candidate.exited);
  if (!session) throw new Error("no modeled live agent");
  return { ...session, cmd: session.cmd ?? [] };
}

const screen = (session: SessionHandle) => captureVisible(session.term);

/**
 * Every other attachclient unit hosts the daemon in the test process. This
 * claim needs a separate pid: agents must outlive the client that started them.
 */
testEffect("a daemon started on demand keeps agents between two separate clients", () =>
  Effect.gen(function* () {
    const home = tempDir("autostart");
    const inheritedPath = yield* Config.option(Config.string("PATH"));
    const env = {
      PATH: Option.getOrUndefined(inheritedPath),
      HOME: home,
      XDG_STATE_HOME: join(home, "state"),
    };
    const id = "autostart";

    const first = yield* connect(id, env, { client: "first" });
    try {
      const lease = yield* run(
        Effect.flatMap(SessionStore, (store) => store.readLease(id)),
        env,
      );
      expect(lease?.pid).toBeGreaterThan(0);
      expect(lease!.pid).not.toBe(process.pid);

      const saved = modeledAgent(first);
      const session = yield* SessionHandle.make({ ...saved, backend: first.backend() });
      sessions.push(session);
      session.write("printf 'across-processes\\n'\n");
      yield* until(() => screen(session).includes("across-processes"), "the daemon's echo");
      first.close();

      const second = yield* connect(id, env, { client: "second" });
      expect(second.live).toContain(session.id);
      const readopted = yield* SessionHandle.make({
        ...saved,
        backend: second.backend(),
      });
      sessions.push(readopted);
      readopted.write("printf 'still-alive\\n'\n");
      yield* until(() => screen(readopted).includes("still-alive"), "the adopted agent's echo");
      yield* run(second.stop, env);
    } finally {
      const lease = yield* run(
        Effect.flatMap(SessionStore, (store) => store.readLease(id)),
        env,
      );
      if (lease && (yield* processAlive(lease.pid))) process.kill(lease.pid, "SIGKILL");
    }
  }),
);
