import { Config, Effect, Option, Schema as S } from "effect";
import { BunServices } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ProcessPluginInvocationContext } from "./env.ts";
import {
  defaultProcessPluginRoots,
  linkProcessPlugin,
  listProcessPlugins,
  unlinkProcessPlugin,
  type ProcessPluginRoots,
} from "./registry.ts";
import { resolveProcessPluginAction, resolveProcessPluginPane } from "./resolve.ts";

export const PROCESS_PLUGIN_CLI_HELP = [
  "usage: amux process-plugin <command> [args]",
  "",
  "  link <path>                         register a local amux-plugin.{json,toml} directory",
  "  unlink <id>                         unregister a process plugin (files stay)",
  "  ls                                  list linked process plugins",
  "  action invoke <plugin> <action>     run a manifest action (waits for exit)",
  "  pane open <plugin> <entrypoint>     open a manifest pane via the daemon",
  "",
  "Daemon/keybind surface:",
  "  process-plugin.action.invoke { plugin, action }",
  "  process-plugin.pane.open { plugin, entrypoint }",
  "  [[panes]] placement = tiled|floating|left|right|top|bottom (amux Placement)",
  "  [[panes]] transient = true restores prior focus when the session exits",
  "  [[startup]] commands run once after daemon restore (killed on shutdown)",
  "Linked actions/panes also appear in the command palette (unbound); assign",
  "keys in settings. Reload amux.commands after link to refresh the list.",
  "",
  "Process plugins are separate argv processes (herdr/cmux-inspired).",
  "Cordis in-process plugins stay under `amux plugin`.",
].join("\n");

const ACTION_OUTPUT_MAX_BYTES = 64 * 1024;

type Fs = FileSystem.FileSystem | Path.Path;

const errorMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

const readEnv = (name: string): Effect.Effect<Option.Option<string>> =>
  Config.option(Config.string(name)).pipe(Effect.orElseSucceed(() => Option.none()));

const currentBinPath = (): string | undefined => {
  try {
    return process.execPath;
  } catch {
    return undefined;
  }
};

const cappedRead = (stream: ReadableStream<Uint8Array> | null): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () =>
      stream === null
        ? Promise.resolve("")
        : new Response(stream).arrayBuffer().then((buffer) => {
            const bytes = new Uint8Array(buffer).subarray(0, ACTION_OUTPUT_MAX_BYTES);
            return Buffer.from(bytes).toString("utf8");
          }),
    catch: () => "",
  }).pipe(Effect.orElseSucceed(() => ""));

/** Run a process-plugin action as a child of this CLI and wait for exit. */
export const invokeProcessPluginAction = (
  pluginId: string,
  actionId: string,
  options: {
    readonly roots?: ProcessPluginRoots;
    readonly context?: ProcessPluginInvocationContext;
  } = {},
): Effect.Effect<
  { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string },
  string,
  Fs
> =>
  Effect.gen(function* () {
    const controlSocket = yield* readEnv("AMUX_CONTROL_SOCKET");
    const processStateSocket = yield* readEnv("AMUX_PROCESS_STATE_SOCKET");
    const resolved = yield* resolveProcessPluginAction(pluginId, actionId, {
      roots: options.roots,
      binPath: currentBinPath(),
      ...(Option.isSome(controlSocket) ? { controlSocket: controlSocket.value } : {}),
      ...(Option.isSome(processStateSocket)
        ? { processStateSocket: processStateSocket.value }
        : {}),
      context:
        options.context ?? { invocationSource: "cli", correlationId: "process-plugin-action" },
    });
    const child = Bun.spawn([...resolved.argv], {
      cwd: resolved.cwd,
      env: { ...process.env, ...resolved.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = yield* Effect.all([
      cappedRead(child.stdout),
      cappedRead(child.stderr),
      Effect.tryPromise({
        try: () => child.exited,
        catch: (error) => `cannot run action '${actionId}': ${String(error)}`,
      }),
    ]);
    return { exitCode, stdout, stderr };
  });

/**
 * `amux process-plugin ...` — carved into core's CLI like `amux plugin`, so it
 * works with zero Cordis plugins installed.
 */
export function runProcessPluginCli(
  argv: readonly string[],
  roots: ProcessPluginRoots = defaultProcessPluginRoots(),
): Promise<number> {
  const writeOut = (text: string) => process.stdout.write(text + "\n");
  const writeErr = (text: string) => process.stderr.write(text + "\n");
  const program = Effect.gen(function* () {
    const [verb, arg, ...rest] = argv;
    if (verb === "-h" || verb === "--help" || arg === "-h" || arg === "--help") {
      writeOut(PROCESS_PLUGIN_CLI_HELP);
      return 0;
    }
    switch (verb) {
      case "link": {
        if (arg === undefined || rest.length > 0) {
          writeErr("usage: amux process-plugin link <path>");
          return 2;
        }
        return yield* linkProcessPlugin(arg, { roots }).pipe(
          Effect.tap((linked) =>
            Effect.sync(() =>
              writeOut(`linked ${linked.pluginId} ${linked.version} (${linked.pluginRoot})`),
            ),
          ),
          Effect.as(0),
          Effect.catch((error) =>
            Effect.sync(() => {
              writeErr(`error: ${errorMessage(error)}`);
              return 1;
            }),
          ),
        );
      }
      case "unlink": {
        if (arg === undefined || rest.length > 0) {
          writeErr("usage: amux process-plugin unlink <id>");
          return 2;
        }
        return yield* unlinkProcessPlugin(arg, { roots }).pipe(
          Effect.tap((removed) =>
            Effect.sync(() =>
              writeOut(removed ? `unlinked ${arg}` : `process plugin '${arg}' was not linked`),
            ),
          ),
          Effect.as(0),
          Effect.catch((error) =>
            Effect.sync(() => {
              writeErr(`error: ${errorMessage(error)}`);
              return 1;
            }),
          ),
        );
      }
      case "ls": {
        if (arg !== undefined) {
          writeErr("usage: amux process-plugin ls");
          return 2;
        }
        return yield* listProcessPlugins({ roots }).pipe(
          Effect.tap((plugins) =>
            Effect.sync(() => {
              if (plugins.length === 0) {
                writeOut("(no process plugins linked)");
                return;
              }
              for (const plugin of plugins) {
                const flag = plugin.enabled ? "" : " (disabled)";
                writeOut(`${plugin.pluginId}\t${plugin.version}\t${plugin.pluginRoot}${flag}`);
              }
            }),
          ),
          Effect.as(0),
          Effect.catch((error) =>
            Effect.sync(() => {
              writeErr(`error: ${errorMessage(error)}`);
              return 1;
            }),
          ),
        );
      }
      case "action": {
        if (arg !== "invoke" || rest.length !== 2) {
          writeErr("usage: amux process-plugin action invoke <plugin> <action>");
          return 2;
        }
        const [pluginId, actionId] = rest as [string, string];
        return yield* invokeProcessPluginAction(pluginId, actionId, { roots }).pipe(
          Effect.tap(({ exitCode, stdout, stderr }) =>
            Effect.sync(() => {
              if (stdout) process.stdout.write(stdout);
              if (stderr) process.stderr.write(stderr);
              if (exitCode !== 0 && exitCode !== null) {
                writeErr(`action exited ${exitCode}`);
              }
            }),
          ),
          Effect.map(({ exitCode }) => (exitCode === 0 || exitCode === null ? 0 : 1)),
          Effect.catch((error) =>
            Effect.sync(() => {
              writeErr(`error: ${error}`);
              return 1;
            }),
          ),
        );
      }
      case "pane": {
        if (arg !== "open" || rest.length < 2 || rest.length > 3) {
          writeErr(
            "usage: amux process-plugin pane open <plugin> <entrypoint> [--axis=row|column]",
          );
          return 2;
        }
        const [pluginId, entrypoint, axisFlag] = rest;
        let axis: "row" | "column" = "row";
        if (axisFlag !== undefined) {
          const match = axisFlag.match(/^--axis=(row|column)$/);
          if (!match) {
            writeErr(
              "usage: amux process-plugin pane open <plugin> <entrypoint> [--axis=row|column]",
            );
            return 2;
          }
          axis = match[1] as "row" | "column";
        }
        return yield* openProcessPluginPane(pluginId!, entrypoint!, { roots, axis }).pipe(
          Effect.tap((result) =>
            Effect.gen(function* () {
              const text = yield* S.encodeEffect(S.fromJsonString(S.Unknown, { space: 2 }))(result);
              writeOut(text);
            }),
          ),
          Effect.as(0),
          Effect.catch((error) =>
            Effect.sync(() => {
              writeErr(`error: ${error}`);
              return 1;
            }),
          ),
        );
      }
      case undefined:
        writeOut(PROCESS_PLUGIN_CLI_HELP);
        return 0;
      default:
        writeErr(`unknown process-plugin command: '${verb}'\n\n${PROCESS_PLUGIN_CLI_HELP}`);
        return 2;
    }
  });
  return Effect.runPromise(program.pipe(Effect.provide(BunServices.layer)));
}

const openProcessPluginPane = (
  pluginId: string,
  entrypointId: string,
  options: {
    readonly roots?: ProcessPluginRoots;
    readonly axis: "row" | "column";
  },
): Effect.Effect<unknown, string, Fs> =>
  Effect.gen(function* () {
    // Existence check only — daemon resolves argv/env from the live registry.
    yield* resolveProcessPluginPane(pluginId, entrypointId, { roots: options.roots });
    const [{ controlCall }, sessionMod, { command }, { Layer }] = yield* Effect.promise(() =>
      Promise.all([
        import("../control-client.ts"),
        import("../session.ts"),
        import("../commands.ts"),
        import("effect").then((m) => ({ Layer: m.Layer })),
      ]),
    );
    const fromDaemon = yield* readEnv("AMUX_DAEMON_SESSION");
    const fromSession = yield* readEnv("AMUX_SESSION");
    const session =
      Option.getOrUndefined(fromDaemon) ??
      Option.getOrUndefined(fromSession) ??
      (() => {
        const fromArgs = process.argv.find((arg) => arg.startsWith("--session="));
        return fromArgs?.slice("--session=".length);
      })();
    if (session === undefined || !sessionMod.isSessionId(session)) {
      return yield* Effect.fail(
        "pane open requires a managed amux session (AMUX_DAEMON_SESSION or --session)",
      );
    }
    const payload = command("process-plugin.pane.open", {
      plugin: pluginId,
      entrypoint: entrypointId,
      axis: options.axis,
    });
    const { BunFileSystem } = yield* Effect.promise(() => import("@effect/platform-bun"));
    const result = yield* controlCall(session, (control) =>
      control.Batch({ values: [payload] }),
    ).pipe(
      Effect.provide(sessionMod.SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
      Effect.mapError(errorMessage),
    );
    return Option.getOrElse(Option.fromNullishOr(result.outputs[0]?.result), () => ({ ok: true }));
  });
