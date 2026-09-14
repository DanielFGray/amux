/**
 * One wire smoke: DocumentOpen / Apply / Save over the daemon control RPC.
 *
 * Apply/stale, subscribe, and contend live in text-buffer buffer.test.ts.
 */

import { afterEach, expect } from "bun:test";
import { ConfigProvider, Effect, Layer, Path } from "effect";
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
