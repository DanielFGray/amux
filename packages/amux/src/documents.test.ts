/**
 * Open documents over the daemon's real control RPC — the same plane as paste
 * buffers. Proves editor and agent clients can share one sequenced store with
 * no client attached.
 */
import { afterEach, expect } from "bun:test";
import { ConfigProvider, Effect, Fiber, Layer, Option, Path, Stream } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { controlCall, type ControlClient } from "./control-client.ts";
import { fileUriFromPath } from "./document-uri.ts";
import { registerCleanup, tempDir } from "./test-tmp.ts";
import { SessionStore } from "./session.ts";
import { testEffect } from "./test-effect.ts";

registerCleanup();

const join = (...paths: string[]) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.join(...paths)).pipe(Effect.provide(Path.layer)),
  );
const daemons: SessionDaemonService[] = [];
afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const daemon of daemons.splice(0)) yield* daemon.stop.pipe(Effect.ignore);
    }),
  ),
);
const started = Effect.fnUntraced(function* (id: string) {
  const home = tempDir("documents");
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") };
  const daemon = yield* Effect.scoped(startDaemon(id)).pipe(
    Effect.provide(
      SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );
  daemons.push(daemon);
  return { daemon, env, home };
});

const rpc = <A, E>(
  id: string,
  use: (control: ControlClient) => Effect.Effect<A, E>,
  env: NodeJS.ProcessEnv,
) =>
  controlCall(id, use).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );

testEffect("DocumentOpen loads from disk and DocumentApply sequences generations", () =>
  Effect.gen(function* () {
    const { env, home } = yield* started("docs-apply");
    const path = join(home, "main.ts");
    yield* Effect.promise(() => Bun.write(path, "const x = 1\n"));
    const uri = fileUriFromPath(path);

    const opened = yield* rpc("docs-apply", (c) => c.DocumentOpen({ uri }), env);
    expect(opened.generation).toBe(1);
    expect(opened.dirty).toBe(false);
    expect(opened.lineCount).toBe(1);

    const applied = yield* rpc(
      "docs-apply",
      (c) =>
        c.DocumentApply({
          uri,
          baseGeneration: 1,
          edits: [
            {
              range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } },
              newText: "2",
            },
          ],
        }),
      env,
    );
    expect(applied.generation).toBe(2);
    expect(applied.dirty).toBe(true);

    const stale = yield* Effect.flip(
      rpc(
        "docs-apply",
        (c) =>
          c.DocumentApply({
            uri,
            baseGeneration: 1,
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                newText: "let",
              },
            ],
          }),
        env,
      ),
    );
    expect(String(stale)).toContain("stale generation");

    const snap = yield* rpc("docs-apply", (c) => c.DocumentSnapshot({ uri }), env);
    expect(snap.text).toBe("const x = 2\n");

    yield* rpc("docs-apply", (c) => c.DocumentSave({ uri }), env);
    expect(yield* Effect.promise(() => Bun.file(path).text())).toBe("const x = 2\n");
    const saved = yield* rpc("docs-apply", (c) => c.DocumentSnapshot({ uri }), env);
    expect(saved.dirty).toBe(false);
  }),
);

testEffect("DocumentWrite from a second client races on generation like an agent would", () =>
  Effect.gen(function* () {
    const { env, home } = yield* started("docs-race");
    const path = join(home, "race.ts");
    yield* Effect.promise(() => Bun.write(path, "one\n"));
    const uri = fileUriFromPath(path);

    yield* rpc("docs-race", (c) => c.DocumentOpen({ uri }), env);
    const human = yield* rpc(
      "docs-race",
      (c) => c.DocumentWrite({ uri, baseGeneration: 1, text: "human\n" }),
      env,
    );
    expect(human.generation).toBe(2);

    const agent = yield* Effect.flip(
      rpc("docs-race", (c) => c.DocumentWrite({ uri, baseGeneration: 1, text: "agent\n" }), env),
    );
    expect(String(agent)).toContain("stale generation");

    const retry = yield* rpc(
      "docs-race",
      (c) => c.DocumentWrite({ uri, baseGeneration: 2, text: "agent\n" }),
      env,
    );
    expect(retry.generation).toBe(3);
    expect((yield* rpc("docs-race", (c) => c.DocumentSnapshot({ uri }), env)).text).toBe("agent\n");
  }),
);

testEffect("DocumentWatch seeds the open snapshot and streams later writes", () =>
  Effect.gen(function* () {
    const { env, home, daemon } = yield* started("docs-watch");
    const path = join(home, "watch.ts");
    yield* Effect.promise(() => Bun.write(path, "seed\n"));
    const uri = fileUriFromPath(path);

    yield* rpc("docs-watch", (c) => c.DocumentOpen({ uri }), env);

    const first = yield* rpc(
      "docs-watch",
      (c) =>
        Effect.gen(function* () {
          const head = yield* Stream.runHead(c.DocumentWatch({ uri }));
          return Option.getOrThrow(head);
        }),
      env,
    );
    expect(first.text).toBe("seed\n");
    expect(first.generation).toBe(1);

    // Hold the stream open while a concurrent write lands.
    const seen = yield* rpc(
      "docs-watch",
      (c) =>
        Effect.gen(function* () {
          const stream = c.DocumentWatch({ uri });
          const fiber = yield* Effect.forkChild(
            stream.pipe(Stream.drop(1), Stream.take(1), Stream.runHead),
          );
          yield* Effect.sleep("50 millis");
          yield* c.DocumentWrite({ uri, baseGeneration: 1, text: "live\n" });
          return Option.getOrThrow(yield* Fiber.join(fiber));
        }),
      env,
    );
    expect(seen.text).toBe("live\n");
    expect(seen.generation).toBe(2);

    yield* daemon.stop.pipe(Effect.ignore);
    daemons.splice(daemons.indexOf(daemon), 1);
  }),
);
