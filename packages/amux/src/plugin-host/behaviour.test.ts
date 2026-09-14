/** @effect-diagnostics *:skip-file -- drives a real supervised child (spawn, sockets). */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  ConfigProvider,
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Path,
  Scope,
  Schema as S,
} from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { startDaemon, type SessionDaemonService } from "../daemon.ts";
import { SessionStore } from "../session.ts";
import { controlCall, connectRpcPath } from "../control-client.ts";
import { command, runtimeCommand } from "../commands.ts";
import { DEFAULT_CONFIG, type Config } from "../config.ts";
import { waitFor } from "../test-wait.ts";
import { registerCleanup, tempDir } from "../test-tmp.ts";
import { PluginHostRpcs, PluginHostSerialization } from "./rpc.ts";
import { PluginPublicationChanged } from "../plugin-behaviour.ts";
import {
  decodeAttachFrames,
  encodeAttachFrame,
  type AttachFrame,
} from "../effect/AttachProtocol.ts";
import type { ControlClient } from "../control-client.ts";

registerCleanup();

const harness = new URL("../../../plugin-agent-harness/src/index.tsx", import.meta.url).pathname;
const continuity = new URL("../../../plugin-agent-continuity", import.meta.url).pathname;
const editor = new URL("../../../editor", import.meta.url).pathname;
const niri = new URL("../../../plugin-niri", import.meta.url).pathname;

type TestEnv = {
  readonly HOME: string;
  readonly XDG_STATE_HOME: string;
  readonly XDG_CONFIG_HOME: string;
};

const provideEnv = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  e: TestEnv,
): Effect.Effect<A, E, Exclude<R, SessionStore | FileSystem.FileSystem | Path.Path>> =>
  effect.pipe(
    Effect.provide(
      SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(e)),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path | Scope.Scope>,
  e: TestEnv,
) => Effect.runPromise(Effect.scoped(provideEnv(effect, e)));

const pluginPaths = [
  { path: harness, enabled: true },
  { path: continuity, enabled: true },
  { path: editor, enabled: true },
  { path: niri, enabled: true },
] as const;

const makePluginConfig = (plugins: Config["plugins"] = [...pluginPaths]): Config => ({
  ...DEFAULT_CONFIG,
  plugins,
});

async function writeConfig(configHome: string, plugins: Config["plugins"]): Promise<void> {
  await mkdir(join(configHome, "amux"), { recursive: true });
  await writeFile(join(configHome, "amux", "config.json"), JSON.stringify({ plugins }));
}

async function started(id: string, pluginConfig: Config = makePluginConfig()) {
  const home = tempDir("host-behaviour");
  const configHome = join(home, "config");
  await writeConfig(configHome, pluginConfig.plugins);
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: configHome,
  } satisfies TestEnv;
  const daemon = await run(startDaemon(id, { pluginConfig }), env);
  return { daemon, env, pluginConfig, configHome };
}

/** Start from disk config only — reload rewrites the file under XDG_CONFIG_HOME. */
async function startedFromDisk(id: string, plugins: Config["plugins"] = [...pluginPaths]) {
  const home = tempDir("host-behaviour");
  const configHome = join(home, "config");
  await writeConfig(configHome, plugins);
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: configHome,
  } satisfies TestEnv;
  const daemon = await run(startDaemon(id), env);
  return { daemon, env, configHome };
}

const ctl = <A, E>(
  id: string,
  env: TestEnv,
  use: (control: ControlClient) => Effect.Effect<A, E>,
) => run(controlCall(id, use), env);

const waitReady = async (d: SessionDaemonService, e: TestEnv) => {
  let report = await ctl(d.id, e, (c) => c.Status());
  await waitFor(
    async () => {
      report = await ctl(d.id, e, (c) => c.Status());
      return report.pluginHost.state === "ready";
    },
    "plugin-host to become ready",
    30_000,
  );
  return report;
};

const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

const attach = (path: string, client: string) => {
  const frames: AttachFrame[] = [];
  let buffer = "";
  return Bun.connect({
    unix: path,
    socket: {
      binaryType: "buffer",
      open(socket) {
        socket.write(encodeAttachFrame({ _tag: "hello", client }));
      },
      data(_socket, data) {
        buffer += data.toString("utf8");
        const decoded = decodeAttachFrames(buffer);
        buffer = decoded.rest;
        frames.push(...decoded.frames);
      },
    },
  }).then((socket) => ({ socket, frames }));
};

const outputText = (frames: AttachFrame[]) =>
  frames
    .filter((frame) => frame._tag === "output")
    .map((frame) => Buffer.from(frame.data).toString("utf8"))
    .join("");

test("host Load publishes editor, agent, niri, and continuity declarations; editor.open runs", async () => {
  const { daemon, env } = await started("hb-decls");
  try {
    await waitReady(daemon, env);

    const decls = await ctl(daemon.id, env, (c) => c.PluginDeclarations());
    const tags = new Set(decls.commands.map((entry) => entry.tag));
    expect(tags.has("editor.open")).toBe(true);
    expect(tags.has("agent.new")).toBe(true);
    expect(decls.algorithms.map((entry) => entry.id)).toContain("niri");
    expect(decls.adapters.map((entry) => entry.id).sort()).toEqual(
      ["claude", "codex", "cursor", "opencode"].sort(),
    );
    expect(decls.commands.every((entry) => entry.owner.id.length > 0)).toBe(true);

    const opened = await ctl(daemon.id, env, (c) =>
      c.Batch({
        values: [runtimeCommand("editor.open", {})],
        context,
      }),
    );
    expect(opened.outputs.length).toBe(1);
    expect(opened.outputs[0]?.workspace).toBeDefined();
  } finally {
    await Effect.runPromise(daemon.stop);
  }
}, 60_000);

test("host answers RunTiling for niri and PlanResume for continuity", async () => {
  const { daemon, env } = await started("hb-rpc");
  try {
    await waitReady(daemon, env);

    const answer = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connectRpcPath(
            daemon.paths.pluginHost,
            PluginHostRpcs,
            PluginHostSerialization,
            (message) => new Error(message),
          );
          const tiling = yield* client.RunTiling({
            revision: 1,
            algorithmId: "niri",
            operation: {
              _tag: "init",
              panes: [{ id: "a", content: { kind: "pty", session: "a" } }],
              size: { cols: 80, rows: 24 },
            },
          });
          const plan = yield* client.PlanResume({
            revision: 1,
            adapterId: "claude",
            ref: { kind: "id", value: "sess-1" },
          });
          return { tiling, plan };
        }),
      ),
      env,
    );

    expect(answer.tiling._tag).toBe("ok");
    expect(Option.isSome(answer.plan)).toBe(true);
    if (Option.isSome(answer.plan)) {
      expect(answer.plan.value.agent).toBe("claude");
      expect(answer.plan.value.argv).toContain("--resume");
    }
  } finally {
    await Effect.runPromise(daemon.stop);
  }
}, 60_000);

test("behaviour RPC revision must match the host publication over the wire", async () => {
  const { daemon, env, pluginConfig, configHome } = await started("hb-rev");
  try {
    await waitReady(daemon, env);

    const niriInit = {
      _tag: "init" as const,
      panes: [{ id: "a", content: { kind: "pty" as const, session: "a" } }],
      size: { cols: 80, rows: 24 },
    };

    const overWire = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connectRpcPath(
            daemon.paths.pluginHost,
            PluginHostRpcs,
            PluginHostSerialization,
            (message) => new Error(message),
          );
          const stale = yield* client
            .RunTiling({ revision: 0, algorithmId: "niri", operation: niriInit })
            .pipe(Effect.exit);
          const loaded = yield* client.Load({
            plugins: pluginConfig.plugins,
            configDirectory: configHome,
          });
          const staleAfterReload = yield* client
            .RunTiling({ revision: 1, algorithmId: "niri", operation: niriInit })
            .pipe(Effect.exit);
          const current = yield* client.RunTiling({
            revision: loaded.revision,
            algorithmId: "niri",
            operation: niriInit,
          });
          return { stale, loaded, staleAfterReload, current };
        }),
      ),
      env,
    );

    expect(Exit.isFailure(overWire.stale)).toBe(true);
    if (Exit.isFailure(overWire.stale)) {
      const error = Cause.squash(overWire.stale.cause);
      expect(S.is(PluginPublicationChanged)(error)).toBe(true);
      if (S.is(PluginPublicationChanged)(error)) {
        expect(error.expected).toBe(0);
        expect(error.current).toBe(1);
      }
    }
    expect(overWire.loaded.revision).toBe(2);
    expect(Exit.isFailure(overWire.staleAfterReload)).toBe(true);
    if (Exit.isFailure(overWire.staleAfterReload)) {
      const error = Cause.squash(overWire.staleAfterReload.cause);
      expect(S.is(PluginPublicationChanged)(error)).toBe(true);
      if (S.is(PluginPublicationChanged)(error)) {
        expect(error.expected).toBe(1);
        expect(error.current).toBe(2);
      }
    }
    expect(overWire.current._tag).toBe("ok");
  } finally {
    await Effect.runPromise(daemon.stop);
  }
}, 60_000);

test("killing the host fails plugin commands; core and PTY keep working; restart restores plugins", async () => {
  const { daemon, env } = await started("hb-loss");
  try {
    await waitReady(daemon, env);

    const pty = await run(
      daemon.spawnSession({
        id: "keep-alive",
        cmd: ["cat"],
        cols: 80,
        rows: 24,
      }),
      env,
    );
    const viewer = await attach(daemon.paths.attach, "watcher");
    await waitFor(
      async () => (await Effect.runPromise(daemon.getAttachedClients)).includes("watcher"),
      "attach watcher",
      10_000,
    );
    await run(pty.write("before\n"), env);
    await waitFor(
      async () => outputText(viewer.frames).includes("before"),
      "pty echo before kill",
      10_000,
    );

    const before = await ctl(daemon.id, env, (c) => c.Status());
    const oldPid = before.pluginHost.pid;
    expect(typeof oldPid).toBe("number");
    expect(oldPid).toBeGreaterThan(0);
    if (typeof oldPid !== "number") return;
    process.kill(oldPid, "SIGKILL");

    await waitFor(
      async () => {
        const decls = await ctl(daemon.id, env, (c) => c.PluginDeclarations());
        return decls.commands.length === 0;
      },
      "declarations clear after host loss",
      10_000,
    );

    const pluginFail = await ctl(daemon.id, env, (c) =>
      Effect.flip(
        c.Batch({
          values: [runtimeCommand("editor.open", {})],
          context,
        }),
      ),
    );
    expect(pluginFail.message).toContain("unknown command 'editor.open'");
    expect(pluginFail.message).toContain("plugin host not ready");

    const coreOk = await ctl(daemon.id, env, (c) =>
      c.Batch({
        values: [command("pane.split", { axis: "row" })],
        context,
      }),
    );
    expect(coreOk.outputs[0]?.workspace).toBeDefined();

    await run(pty.write("after-kill\n"), env);
    await waitFor(
      async () => outputText(viewer.frames).includes("after-kill"),
      "pty echo after host kill",
      10_000,
    );

    await waitReady(daemon, env);
    const decls = await ctl(daemon.id, env, (c) => c.PluginDeclarations());
    expect(decls.commands.some((entry) => entry.tag === "editor.open")).toBe(true);
    const opened = await ctl(daemon.id, env, (c) =>
      c.Batch({
        values: [runtimeCommand("editor.open", {})],
        context,
      }),
    );
    expect(opened.outputs[0]?.workspace).toBeDefined();

    viewer.socket.end();
  } finally {
    await Effect.runPromise(daemon.stop);
  }
}, 90_000);

test("plugin.reload drops a disabled plugin from declarations", async () => {
  const { daemon, env, configHome } = await startedFromDisk("hb-reload");
  try {
    await waitReady(daemon, env);

    const before = await ctl(daemon.id, env, (c) => c.PluginDeclarations());
    expect(before.commands.some((entry) => entry.tag === "editor.open")).toBe(true);

    await writeConfig(
      configHome,
      pluginPaths.map((spec) =>
        "path" in spec && spec.path === editor ? { ...spec, enabled: false } : { ...spec },
      ),
    );

    await ctl(daemon.id, env, (c) =>
      c.Batch({
        values: [{ _tag: "plugin.reload" }],
        context,
      }),
    );

    const after = await ctl(daemon.id, env, (c) => c.PluginDeclarations());
    expect(after.commands.some((entry) => entry.tag === "editor.open")).toBe(false);
    expect(after.commands.some((entry) => entry.tag === "agent.new")).toBe(true);
  } finally {
    await Effect.runPromise(daemon.stop);
  }
}, 60_000);

test("plugin.reload keeps a working plugin when its edited source fails to import", async () => {
  const home = tempDir("host-behaviour");
  const configHome = join(home, "config");
  const pluginDir = join(configHome, "amux", "probe-plugin");
  await mkdir(pluginDir, { recursive: true });

  const typesPath = new URL("../plugin/types.ts", import.meta.url).pathname;
  const servicesPath = new URL("../plugin/services.ts", import.meta.url).pathname;
  const definePath = new URL("../define-daemon-command.ts", import.meta.url).pathname;

  const daemonSource = `import { Effect, Schema as S } from "effect";
import { definePlugin } from ${JSON.stringify(typesPath)};
import { DaemonCommandsTag, registerDaemonCommand } from ${JSON.stringify(servicesPath)};
import { defineDaemonCommand } from ${JSON.stringify(definePath)};

const ping = defineDaemonCommand({
  tag: "probe.ping",
  fields: S.Struct({}),
  meta: { desc: "probe", group: "probe", target: "session", exposure: "agent" },
  resources: () => [],
  run: () => Effect.void,
});

export default definePlugin({
  id: "probe.daemon",
  inject: [DaemonCommandsTag],
  effect: () => registerDaemonCommand(ping),
});
`;
  const clientSource = `import { Effect } from "effect";
import { definePlugin } from ${JSON.stringify(typesPath)};
export default definePlugin({ id: "probe", effect: () => Effect.void });
`;

  const probePath = join(pluginDir, "probe.ts");
  await writeFile(probePath, clientSource);
  await writeFile(join(pluginDir, "daemon.ts"), daemonSource);
  await writeConfig(configHome, [{ path: probePath, enabled: true }]);

  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: configHome,
  } satisfies TestEnv;
  const daemon = await run(startDaemon("hb-reload-keep"), env);
  try {
    await waitReady(daemon, env);

    const before = await ctl(daemon.id, env, (c) => c.PluginDeclarations());
    expect(before.commands.some((entry) => entry.tag === "probe.ping")).toBe(true);

    await writeFile(join(pluginDir, "daemon.ts"), `throw new Error("broken edit");\n`);

    const reloaded = await ctl(daemon.id, env, (c) =>
      c.Batch({
        values: [{ _tag: "plugin.reload" }],
        context,
      }),
    );

    expect(reloaded.outputs[0]?.result).toEqual([
      { spec: probePath, reason: expect.stringContaining("broken edit") },
    ]);

    const after = await ctl(daemon.id, env, (c) => c.PluginDeclarations());
    expect(after.commands.some((entry) => entry.tag === "probe.ping")).toBe(true);
  } finally {
    await Effect.runPromise(daemon.stop);
  }
}, 60_000);
