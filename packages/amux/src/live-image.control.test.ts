/**
 * Live-image demo loop over a real control socket.
 *
 * Unit tests cover eval / inspect / promote in isolation.
 * This suite is the wiring proof: daemon → Batch → runOnClient → createApp
 * command handlers → reply, then a fresh client load from the promoted
 * config path. Same seam as control.test.ts / attachclient.test.ts; the
 * app half mirrors lifetimes.test.ts (real createApp + test renderer).
 *
 * @effect-diagnostics *:skip-file -- real OS boundary (sockets, dynamic
 * import, renderer) driven unmocked; see packages/amux/src/harness.ts.
 */
import { afterEach, expect } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Exit, Layer, Path, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { createApp } from "./app.tsx";
import { SessionClient, type SessionClientContract } from "./client.ts";
import { command } from "./commands.ts";
import { DEFAULT_CONFIG, loadConfig, type Config } from "./config.ts";
import { controlCall, type ControlClient } from "./control-client.ts";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import {
  managedPluginEntryPath,
  managedPluginSpecPath,
  pluginScratchDir,
  scratchEntryPath,
} from "./plugin/scratch.ts";
import { errorMessage } from "./error-message.ts";
import { SessionStore } from "./session.ts";
import { testEffect } from "./test-effect.ts";
import { registerCleanup, tempDir } from "./test-tmp.ts";
import { until } from "./test-wait.ts";

registerCleanup();

const daemons: SessionDaemonService[] = [];
const clients: SessionClientContract[] = [];
const scopes: Scope.Closeable[] = [];
const renderers: Array<{ destroy: () => void }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const scope of scopes.splice(0))
    await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.ignore));
  for (const renderer of renderers.splice(0)) renderer.destroy();
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop.pipe(Effect.ignore));
});

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path | Scope.Scope>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(
        SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  );

const provideEnv = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path>,
  env: NodeJS.ProcessEnv,
) =>
  effect.pipe(
    Effect.provide(
      SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );

async function started(id: string) {
  const home = tempDir("live-image");
  const configHome = join(home, "config");
  const configDir = join(configHome, "amux");
  const configPath = join(configDir, "config.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ plugins: [] }));
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: configHome,
  } as NodeJS.ProcessEnv;
  const daemon = await run(startDaemon(id, { pluginConfig: structuredClone(DEFAULT_CONFIG) }), env);
  daemons.push(daemon);
  return { daemon, env, configDir, configPath };
}

const ctl = <A, E>(
  id: string,
  env: NodeJS.ProcessEnv,
  use: (control: ControlClient) => Effect.Effect<A, E>,
) => run(controlCall(id, use), env);

const socketContext = {
  size: { cols: 80, rows: 24 },
  shell: ["sh"],
  cwd: "/tmp",
  source: "socket" as const,
};

const batch = (id: string, env: NodeJS.ProcessEnv, value: ReturnType<typeof command>) =>
  ctl(id, env, (c) => c.Batch({ values: [value], context: socketContext })).then(
    (result) => result.outputs[0]!,
  );

/** Context id the demo plugin registers its binding under. */
const DEMO_CONTEXT = "demo.scope";

/** Scratch plugin that also installs a predicated context + a binding scoped to
 *  it — proves a contributed context reaches inspect over the live eval → socket
 *  path, including `whyActive`. */
const demoSource = (pluginId: string) =>
  `import { Effect } from "effect";
import { definePlugin, BindingsTag, ContextsTag, contextCommand, CONTEXT_PRIORITY } from "amux";
export default definePlugin({
  id: ${JSON.stringify(pluginId)},
  inject: [BindingsTag, ContextsTag],
  effect: () => Effect.gen(function* () {
    const bindings = yield* BindingsTag;
    const contexts = yield* ContextsTag;
    const scope = {
      id: ${JSON.stringify(DEMO_CONTEXT)},
      active: () => true,
      priority: CONTEXT_PRIORITY.PANE,
      rebindable: true,
    };
    yield* contexts.register(scope);
    yield* bindings.register(contextCommand(scope, {
      name: "ping",
      key: "p",
      desc: "live-image demo ping",
      group: "demo",
      run: Effect.void,
    }));
  }),
});
`;

const attachClient = (id: string, env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    scopes.push(scope);
    const client = yield* provideEnv(
      Scope.provide(
        SessionClient.connect(id, { client: "live-image-ui", autostart: false }),
        scope,
      ),
      env,
    );
    clients.push(client);
    return client;
  });

const bootApp = (
  client: SessionClientContract,
  config: Config,
  configDir: string,
): Effect.Effect<
  {
    readonly pluginHost: {
      status: () => readonly { id: string; phase: string }[];
    };
  },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const t = yield* Effect.promise(() => createTestRenderer({ width: 60, height: 20 }));
    renderers.push(t.renderer);
    const paneHost = new BoxRenderable(t.renderer, { id: "live-image-pane-host", flexGrow: 1 });
    return yield* createApp({
      renderer: t.renderer,
      paneHost,
      config: structuredClone(config),
      configDir,
      session: client,
      quit() {},
    });
  });

/** Client reloader is assigned at the end of the plugin-load fiber, after
 *  registries are already active — so host status alone is too early.
 *  `plugin.reload` is server-targeted and must not be used as a probe. */
const waitForEvalReady = (id: string, env: NodeJS.ProcessEnv) =>
  until(
    () =>
      Effect.gen(function* () {
        const evalFlip = yield* Effect.result(
          provideEnv(
            controlCall(id, (c) =>
              c.Batch({
                values: [
                  command("plugin.eval", {
                    plugin: "__amux_live_image_probe__",
                    source: `import { Effect } from "effect";
import { definePlugin } from "amux";
export default definePlugin({
  id: "__amux_live_image_probe__",
  effect: () => Effect.void,
});`,
                  }),
                ],
                context: socketContext,
              }),
            ),
            env,
          ),
        );
        if (evalFlip._tag === "Success") return true;
        return !errorMessage(evalFlip.failure).includes("plugin runtime is unavailable");
      }),
    "client plugin.eval path to become available",
    15_000,
  );

testEffect(
  "demo loop over control socket: eval → inspect → promote → fresh load",
  () =>
    Effect.gen(function* () {
      const sessionId = "live-image-demo";
      const pluginId = `live.e2e.${Date.now()}`;
      const bindingName = `${DEMO_CONTEXT}.ping`;
      const { daemon, env, configDir, configPath } = yield* Effect.promise(() =>
        started(sessionId),
      );
      const client = yield* attachClient(daemon.id, env);

      // --- live client answers runOnClient ---
      const appScope = yield* Scope.make();
      scopes.push(appScope);
      const app = yield* Scope.provide(
        bootApp(client, { ...DEFAULT_CONFIG, plugins: [] }, configDir),
        appScope,
      );
      yield* waitForEvalReady(daemon.id, env);
      // Keep the app alive for runOnClient; status is asserted over the socket.
      expect(app.pluginHost).toBeDefined();

      // describe-key is view-targeted: the socket must refuse it (human panel only).
      const describeKey = yield* Effect.result(
        provideEnv(
          controlCall(daemon.id, (c) =>
            c.Batch({ values: [command("app.describe-key", { plugin: pluginId })] }),
          ),
          env,
        ),
      );
      expect(describeKey._tag).toBe("Failure");
      expect(describeKey._tag === "Failure" ? errorMessage(describeKey.failure) : "").toContain(
        "view command",
      );

      const source = demoSource(pluginId);
      const evaluated = yield* Effect.promise(() =>
        batch(daemon.id, env, command("plugin.eval", { plugin: pluginId, source })),
      );
      expect(evaluated.result).toEqual(
        expect.objectContaining({ plugin: pluginId, path: expect.any(String) }),
      );

      const inspected = yield* Effect.promise(() =>
        batch(daemon.id, env, command("plugin.inspect", { plugin: pluginId })),
      );
      expect(inspected.result).toEqual(
        expect.objectContaining({
          kind: "plugin",
          name: pluginId,
          found: true,
          provider: expect.objectContaining({ pluginId, active: true }),
        }),
      );

      const binding = yield* Effect.promise(() =>
        batch(daemon.id, env, command("plugin.inspect", { binding: bindingName })),
      );
      expect(binding.result).toEqual(
        expect.objectContaining({
          kind: "binding",
          name: bindingName,
          found: true,
          details: expect.objectContaining({ context: DEMO_CONTEXT }),
          whyActive: expect.stringContaining("is active"),
        }),
      );

      const promoted = yield* Effect.promise(() =>
        batch(daemon.id, env, command("plugin.promote", { plugin: pluginId })),
      );
      expect(promoted.result).toEqual({
        plugin: pluginId,
        path: managedPluginSpecPath(pluginId),
      });
      const managed = managedPluginEntryPath(pluginId, configDir);

      expect(yield* Effect.promise(() => readFile(managed, "utf8"))).toContain(pluginId);
      const saved = yield* loadConfig(configPath).pipe(Effect.provide(BunFileSystem.layer));
      expect(saved.plugins).toContainEqual({
        path: managedPluginSpecPath(pluginId),
        enabled: true,
      });

      // Tear down the live app; keep the attach client for the restart half.
      yield* Scope.close(appScope, Exit.void);
      scopes.splice(scopes.indexOf(appScope), 1);

      // --- fresh createApp loads the promoted plugin from config ---
      const restartScope = yield* Scope.make();
      scopes.push(restartScope);
      const restarted = yield* Scope.provide(bootApp(client, saved, configDir), restartScope);
      yield* waitForEvalReady(daemon.id, env);
      yield* until(
        () =>
          restarted.pluginHost
            .status()
            .some((status) => status.id === pluginId && status.phase === "active"),
        `promoted plugin ${pluginId} to activate after restart`,
        15_000,
      );

      const afterRestart = yield* Effect.promise(() =>
        batch(daemon.id, env, command("plugin.inspect", { plugin: pluginId })),
      );
      expect(afterRestart.result).toEqual(
        expect.objectContaining({
          kind: "plugin",
          name: pluginId,
          found: true,
          provider: expect.objectContaining({
            pluginId,
            active: true,
            source: expect.stringContaining("plugins/"),
          }),
        }),
      );

      // Scratch file may linger under the process-wide scratch dir; remove ours.
      const scratchDir = yield* pluginScratchDir;
      yield* Effect.promise(() =>
        rm(scratchEntryPath(pluginId, scratchDir), { force: true }).catch(() => undefined),
      );
    }),
  60_000,
);
