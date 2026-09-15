/**
 * Live-image control-plane proofs for host-owned plugin lifecycle.
 *
 * Public commands only: daemon → Batch → supervised host Prepare/Publish →
 * PluginPublications stream → createApp UI halves. Same seam as
 * control.test.ts / attachclient.test.ts.
 *
 * @effect-diagnostics *:skip-file -- real OS boundary (sockets, dynamic
 * import, renderer) driven unmocked; see packages/amux/src/harness.ts.
 */
import { afterEach, expect } from "bun:test";
import { join } from "node:path";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Exit, Layer, Path, Scope, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import { createApp } from "./app.tsx";
import { SessionClient, type SessionClientContract } from "./client.ts";
import {
  command,
  encodeRegisteredCommand,
  type Command,
  type RegisteredCommand,
} from "./commands.ts";
import { Schema as S } from "effect";
import { DEFAULT_CONFIG, loadConfig, type Config } from "./config.ts";
import { controlCall, type ControlClient } from "./control-client.ts";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import {
  managedPluginEntryPath,
  managedPluginSpecPath,
  pluginScratchDir,
  scratchEntryPath,
  scratchStem,
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

const withTestFs = <A, E, R>(effect: Effect.Effect<A, E, R | FileSystem.FileSystem>) =>
  effect.pipe(Effect.provide(BunFileSystem.layer));

async function started(id: string) {
  const home = tempDir("live-image");
  const configHome = join(home, "config");
  const configDir = join(configHome, "amux");
  const configPath = join(configDir, "config.json");
  await Effect.runPromise(
    withTestFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(configDir, { recursive: true });
        yield* fs.writeFileString(configPath, JSON.stringify({ plugins: [] }));
      }),
    ),
  );
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: configHome,
  } as NodeJS.ProcessEnv;
  // Disk config authority — no sticky pluginConfig, so host Promote/SetEnabled writes are visible.
  const daemon = await run(startDaemon(id), env);
  daemons.push(daemon);
  return { daemon, env, configDir, configPath, home };
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

const batch = (id: string, env: NodeJS.ProcessEnv, value: Command | RegisteredCommand) =>
  ctl(id, env, (c) => c.Batch({ values: [value], context: socketContext })).then(
    (result) => result.outputs[0]!,
  );

const statusOf = (id: string, env: NodeJS.ProcessEnv) => ctl(id, env, (c) => c.Status());

/** Context id the demo plugin registers its binding under. */
const DEMO_CONTEXT = "demo.scope";

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

/** UI + daemon halves: entry is "."; companions under `<stem>/` (e.g. daemon.ts). */
const dualHalfSources = (pluginId: string, token: string) => ({
  ui: `import { Effect } from "effect";
import { definePlugin, BindingsTag, ContextsTag, contextCommand, CONTEXT_PRIORITY } from "amux";
export default definePlugin({
  id: ${JSON.stringify(pluginId)},
  inject: [BindingsTag, ContextsTag],
  effect: () => Effect.gen(function* () {
    const bindings = yield* BindingsTag;
    const contexts = yield* ContextsTag;
    const scope = {
      id: ${JSON.stringify(`${DEMO_CONTEXT}.${token}`)},
      active: () => true,
      priority: CONTEXT_PRIORITY.PANE,
      rebindable: true,
    };
    yield* contexts.register(scope);
    yield* bindings.register(contextCommand(scope, {
      name: "ping",
      key: "p",
      desc: "token ${token}",
      group: "demo",
      run: Effect.void,
    }));
  }),
});
`,
  daemon: `import { Effect, Schema as S } from "effect";
import { definePlugin, DaemonCommandsTag, registerDaemonCommand, defineDaemonCommand } from "amux";

const echo = defineDaemonCommand({
  tag: ${JSON.stringify(`${pluginId}.echo`)},
  fields: S.Struct({ text: S.optionalKey(S.String) }),
  meta: { desc: "echo token ${token}", group: "demo", target: "session", exposure: "agent" },
  resources: () => [],
  run: (command) => Effect.succeed({ token: ${JSON.stringify(token)}, text: command.text ?? "" }),
});

export default definePlugin({
  id: ${JSON.stringify(pluginId)},
  inject: [DaemonCommandsTag],
  effect: () => registerDaemonCommand(echo),
});
`,
});

const attachClient = Effect.fnUntraced(function* (
  id: string,
  env: NodeJS.ProcessEnv,
  name: string,
) {
  const scope = yield* Scope.make();
  scopes.push(scope);
  const client = yield* provideEnv(
    Scope.provide(SessionClient.connect(id, { client: name, autostart: false }), scope),
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

const waitForHostReady = (id: string, env: NodeJS.ProcessEnv) =>
  until(
    () =>
      Effect.gen(function* () {
        const status = yield* provideEnv(
          controlCall(id, (c) => c.Status()),
          env,
        );
        return (
          status.pluginHost.state === "ready" && status.pluginPublicationRevision !== undefined
        );
      }),
    "plugin host publication revision",
    15_000,
  );

const waitForUiPlugin = (
  app: { readonly pluginHost: { status: () => readonly { id: string; phase: string }[] } },
  pluginId: string,
) =>
  until(
    () =>
      app.pluginHost.status().some((status) => status.id === pluginId && status.phase === "active"),
    `UI plugin ${pluginId} active`,
    15_000,
  );

const scratchKeyOf = (pluginId: string) => scratchStem(pluginId);

/** Status.pluginUiByClient: at least `min` control clients report ready for this scratch stem. */
const waitForUiReadyClients = (
  id: string,
  env: NodeJS.ProcessEnv,
  pluginId: string,
  min: number,
) => {
  const stem = scratchKeyOf(pluginId);
  return until(
    () =>
      Effect.gen(function* () {
        const status = yield* provideEnv(
          controlCall(id, (c) => c.Status()),
          env,
        );
        const revision = status.pluginPublicationRevision;
        const byClient = status.pluginUiByClient;
        if (revision === undefined || byClient === undefined) return false;
        let ready = 0;
        for (const report of Object.values(byClient)) {
          if (report.revision !== revision) continue;
          if (report.plugins.some((plugin) => plugin.key.includes(stem) && plugin.ready)) {
            ready += 1;
          }
        }
        return ready >= min;
      }),
    `${min} clients UI-ready for ${pluginId}`,
    15_000,
  );
};

/** At least one client reports this scratch stem not ready, with an error string. */
const waitForUiFailedClient = (id: string, env: NodeJS.ProcessEnv, pluginId: string) => {
  const stem = scratchKeyOf(pluginId);
  return until(
    () =>
      Effect.gen(function* () {
        const status = yield* provideEnv(
          controlCall(id, (c) => c.Status()),
          env,
        );
        const byClient = status.pluginUiByClient;
        if (byClient === undefined) return false;
        return Object.values(byClient).some((report) =>
          report.plugins.some(
            (plugin) =>
              plugin.key.includes(stem) && plugin.ready === false && plugin.error !== undefined,
          ),
        );
      }),
    `UI failure reported for ${pluginId}`,
    15_000,
  );
};

const echoToken = (id: string, env: NodeJS.ProcessEnv, pluginId: string, text: string) =>
  Effect.promise(() =>
    batch(
      id,
      env,
      Effect.runSync(
        encodeRegisteredCommand(`${pluginId}.echo`, S.Struct({ text: S.String }))({ text }),
      ),
    ),
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
      const client = yield* attachClient(daemon.id, env, "live-image-ui");

      const appScope = yield* Scope.make();
      scopes.push(appScope);
      const app = yield* Scope.provide(
        bootApp(client, { ...DEFAULT_CONFIG, plugins: [] }, configDir),
        appScope,
      );
      yield* waitForHostReady(daemon.id, env);
      expect(app.pluginHost).toBeDefined();

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
      yield* waitForUiPlugin(app, pluginId);

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
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(managed)).toContain(pluginId);
      const saved = yield* loadConfig(configPath).pipe(Effect.provide(BunFileSystem.layer));
      expect(saved.plugins).toContainEqual({
        path: managedPluginSpecPath(pluginId),
        enabled: true,
      });

      yield* Scope.close(appScope, Exit.void);
      scopes.splice(scopes.indexOf(appScope), 1);

      const restartScope = yield* Scope.make();
      scopes.push(restartScope);
      const restarted = yield* Scope.provide(bootApp(client, saved, configDir), restartScope);
      yield* waitForHostReady(daemon.id, env);
      yield* waitForUiPlugin(restarted, pluginId);

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

      const scratchDir = yield* pluginScratchDir;
      yield* fs.remove(scratchEntryPath(pluginId, scratchDir), { force: true }).pipe(Effect.ignore);
    }).pipe(Effect.provide(BunFileSystem.layer)),
  60_000,
);

/**
 * One public-command scenario for the host-owned plugin lifecycle.
 * Replaces the three overlapping proofs that each covered a slice of this path.
 */
testEffect(
  "shared plugin lifecycle through public commands",
  () =>
    Effect.gen(function* () {
      const sessionId = "live-image-lifecycle";
      const pluginId = `live.life.${Date.now()}`;
      const { daemon, env, configDir, home } = yield* Effect.promise(() => started(sessionId));
      yield* waitForHostReady(daemon.id, env);

      const fs = yield* FileSystem.FileSystem;
      const scratchDir = join(home, "state", "amux", "scratch");
      const companionDir = join(scratchDir, scratchStem(pluginId));
      yield* fs.makeDirectory(companionDir, { recursive: true });

      // 1. Author UI + daemon halves via plugin.eval (daemon companion on disk first).
      const v1 = dualHalfSources(pluginId, "v1");
      yield* fs.writeFileString(join(companionDir, "daemon.ts"), v1.daemon);
      const evaluated = yield* Effect.promise(() =>
        batch(daemon.id, env, command("plugin.eval", { plugin: pluginId, source: v1.ui })),
      );
      expect(evaluated.result).toEqual(
        expect.objectContaining({ plugin: pluginId, path: expect.any(String) }),
      );

      // 2. Host command runs.
      const echo1 = yield* echoToken(daemon.id, env, pluginId, "step2");
      expect(echo1.result).toEqual(expect.objectContaining({ token: "v1", text: "step2" }));

      const clientA = yield* attachClient(daemon.id, env, "life-a");
      const clientB = yield* attachClient(daemon.id, env, "life-b");
      const scopeA = yield* Scope.make();
      const scopeB = yield* Scope.make();
      scopes.push(scopeA, scopeB);
      const appA = yield* Scope.provide(
        bootApp(clientA, { ...DEFAULT_CONFIG, plugins: [] }, configDir),
        scopeA,
      );
      const appB = yield* Scope.provide(
        bootApp(clientB, { ...DEFAULT_CONFIG, plugins: [] }, configDir),
        scopeB,
      );
      yield* waitForUiPlugin(appA, pluginId);
      yield* waitForUiPlugin(appB, pluginId);
      yield* waitForUiReadyClients(daemon.id, env, pluginId, 2);

      const beforeEdit = yield* Effect.promise(() => statusOf(daemon.id, env));
      const rev0 = beforeEdit.pluginPublicationRevision;
      expect(rev0).toBeDefined();
      if (rev0 === undefined) return;

      // 3. Edit both halves; watched change reaches every client's publication stream; new code runs.
      const nextA = Effect.runPromise(
        Effect.scoped(
          clientA.pluginPublications.pipe(
            Stream.filter((announcement) => announcement.revision > rev0),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      const nextB = Effect.runPromise(
        Effect.scoped(
          clientB.pluginPublications.pipe(
            Stream.filter((announcement) => announcement.revision > rev0),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      const v2 = dualHalfSources(pluginId, "v2");
      yield* fs.writeFileString(join(companionDir, "daemon.ts"), v2.daemon);
      yield* fs.writeFileString(scratchEntryPath(pluginId, scratchDir), v2.ui);
      const [gotA, gotB] = yield* Effect.promise(() => Promise.all([nextA, nextB]));
      expect(gotA[0]!.revision).toBeGreaterThan(rev0);
      expect(gotB[0]!.revision).toBe(gotA[0]!.revision);
      yield* waitForUiPlugin(appA, pluginId);
      yield* waitForUiPlugin(appB, pluginId);
      const echo2 = yield* echoToken(daemon.id, env, pluginId, "step3");
      expect(echo2.result).toEqual(expect.objectContaining({ token: "v2", text: "step3" }));

      // Explicit reload also advances both clients (same proof the watch-only slice had).
      const rev1 = gotA[0]!.revision;
      const reloadA = Effect.runPromise(
        Effect.scoped(
          clientA.pluginPublications.pipe(
            Stream.filter((a) => a.revision > rev1),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      const reloadB = Effect.runPromise(
        Effect.scoped(
          clientB.pluginPublications.pipe(
            Stream.filter((a) => a.revision > rev1),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      yield* Effect.promise(() => batch(daemon.id, env, command("plugin.reload", {})));
      const [rA, rB] = yield* Effect.promise(() => Promise.all([reloadA, reloadB]));
      expect(rA[0]!.revision).toBeGreaterThan(rev1);
      expect(rB[0]!.revision).toBe(rA[0]!.revision);

      // 4. Break the daemon half; last good keeps running; failure is reported.
      yield* fs.writeFileString(
        join(companionDir, "daemon.ts"),
        `this is not a valid daemon module ===`,
      );
      const reloaded = yield* Effect.promise(() =>
        batch(daemon.id, env, command("plugin.reload", {})),
      );
      expect(reloaded.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            spec: expect.stringContaining(scratchStem(pluginId)),
            reason: expect.any(String),
          }),
        ]),
      );
      const echoKept = yield* echoToken(daemon.id, env, pluginId, "step4");
      expect(echoKept.result).toEqual(expect.objectContaining({ token: "v2", text: "step4" }));
      expect(appA.pluginHost.status().some((s) => s.id === pluginId && s.phase === "active")).toBe(
        true,
      );

      // 5. Detach every client; host command still runs with nobody attached.
      yield* Scope.close(scopeA, Exit.void);
      yield* Scope.close(scopeB, Exit.void);
      scopes.splice(scopes.indexOf(scopeA), 1);
      scopes.splice(scopes.indexOf(scopeB), 1);
      clientA.close();
      clientB.close();
      clients.splice(0, clients.length);
      const echoDetached = yield* echoToken(daemon.id, env, pluginId, "step5");
      expect(echoDetached.result).toEqual(expect.objectContaining({ token: "v2", text: "step5" }));

      // 6. Reattach two clients; both share the active publication revision / UI readiness.
      const clientC = yield* attachClient(daemon.id, env, "life-c");
      const clientD = yield* attachClient(daemon.id, env, "life-d");
      const scopeC = yield* Scope.make();
      const scopeD = yield* Scope.make();
      scopes.push(scopeC, scopeD);
      const appC = yield* Scope.provide(
        bootApp(clientC, { ...DEFAULT_CONFIG, plugins: [] }, configDir),
        scopeC,
      );
      const appD = yield* Scope.provide(
        bootApp(clientD, { ...DEFAULT_CONFIG, plugins: [] }, configDir),
        scopeD,
      );
      yield* waitForUiPlugin(appC, pluginId);
      yield* waitForUiPlugin(appD, pluginId);
      yield* waitForUiReadyClients(daemon.id, env, pluginId, 2);
      const statusBoth = yield* Effect.promise(() => statusOf(daemon.id, env));
      const sharedRevision = statusBoth.pluginPublicationRevision;
      expect(sharedRevision).toBeDefined();
      if (sharedRevision === undefined) return;
      const readyReports = Object.values(statusBoth.pluginUiByClient ?? {});
      expect(readyReports.length).toBeGreaterThanOrEqual(2);
      for (const report of readyReports) {
        expect(report.revision).toBe(sharedRevision);
      }

      // 7. Failed UI import does not block the host command or the PTY owner; readiness shows.
      yield* fs.writeFileString(
        scratchEntryPath(pluginId, scratchDir),
        `this is not valid ui ===\n`,
      );
      yield* Effect.promise(() => batch(daemon.id, env, command("plugin.reload", {})));
      yield* waitForUiFailedClient(daemon.id, env, pluginId);
      const echoDuringUiFail = yield* echoToken(daemon.id, env, pluginId, "step7");
      expect(echoDuringUiFail.result).toEqual(
        expect.objectContaining({ token: "v2", text: "step7" }),
      );
      // Spawn a session-backed pane while UI is failed — daemon owns the PTY.
      const split = yield* Effect.promise(() =>
        batch(daemon.id, env, command("pane.split", { axis: "row" })),
      );
      expect(split.result).toEqual(
        expect.objectContaining({ session: expect.any(String), pane: expect.any(String) }),
      );
      const created = split.result as { session: string; pane: string };
      const panes = yield* Effect.promise(() => batch(daemon.id, env, command("pane.list", {})));
      expect(panes.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.pane, session: created.session }),
        ]),
      );
      const statusDuringFail = yield* Effect.promise(() => statusOf(daemon.id, env));
      expect(statusDuringFail.agents).toContain(created.session);
      const failedUi = Object.values(statusDuringFail.pluginUiByClient ?? {}).some((report) =>
        report.plugins.some(
          (plugin) =>
            plugin.key.includes(scratchStem(pluginId)) &&
            plugin.ready === false &&
            plugin.error !== undefined,
        ),
      );
      expect(failedUi).toBe(true);

      // Restore UI so restart clients can load; leave daemon half broken so last-good recovers it.
      yield* fs.writeFileString(scratchEntryPath(pluginId, scratchDir), v2.ui);

      // 8. Host restart recovers the last published (checkpointed) daemon source.
      yield* Scope.close(scopeC, Exit.void);
      yield* Scope.close(scopeD, Exit.void);
      clientC.close();
      clientD.close();
      clients.splice(0, clients.length);
      yield* daemon.stop;
      daemons.splice(0, daemons.length);
      const restarted = yield* Effect.promise(() => run(startDaemon(sessionId), env));
      daemons.push(restarted);
      yield* waitForHostReady(restarted.id, env);
      const echoRestart = yield* echoToken(restarted.id, env, pluginId, "step8");
      expect(echoRestart.result).toEqual(expect.objectContaining({ token: "v2", text: "step8" }));

      const clientE = yield* attachClient(restarted.id, env, "life-e");
      const clientF = yield* attachClient(restarted.id, env, "life-f");
      const scopeE = yield* Scope.make();
      const scopeF = yield* Scope.make();
      scopes.push(scopeE, scopeF);
      const appE = yield* Scope.provide(
        bootApp(clientE, { ...DEFAULT_CONFIG, plugins: [] }, configDir),
        scopeE,
      );
      const appF = yield* Scope.provide(
        bootApp(clientF, { ...DEFAULT_CONFIG, plugins: [] }, configDir),
        scopeF,
      );
      yield* waitForUiPlugin(appE, pluginId);
      yield* waitForUiPlugin(appF, pluginId);
      const afterRestart = yield* Effect.promise(() => statusOf(restarted.id, env));
      expect(afterRestart.pluginPublicationRevision).toBeDefined();
      const statusE = yield* Effect.promise(() => statusOf(restarted.id, env));
      const statusF = yield* Effect.promise(() => statusOf(restarted.id, env));
      expect(statusE.pluginPublicationRevision).toBe(statusF.pluginPublicationRevision);
    }).pipe(Effect.provide(BunFileSystem.layer)),
  180_000,
);
