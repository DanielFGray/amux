import { Effect, Result, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path computation, not I/O.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_NAME = "amux-agent-state.js";
const MARKER = "AMUX_AGENT_STATE_PLUGIN=1";

export class AgentHookError extends S.TaggedError<AgentHookError>()("AgentHookError", {
  message: S.String,
}) {}

export const opencodePluginPath = (home = homeDir()) =>
  join(home, ".config", "opencode", "plugins", INSTALL_NAME);

function homeDir(): string {
  // @effect-diagnostics-next-line processEnv:off -- default-argument fallback, evaluated once at call sites outside any Effect.
  return process.env.HOME ?? ".";
}

export const installOpencodeHook = (
  home = homeDir(),
): Effect.Effect<string, PlatformError | AgentHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configDir = join(home, ".config", "opencode");
    const pluginPath = opencodePluginPath(home);

    const info = yield* fs.stat(configDir).pipe(Effect.result);
    if (Result.isFailure(info) || info.success.type !== "Directory") {
      return yield* new AgentHookError({
        message: `opencode config directory not found at ${configDir}`,
      });
    }

    yield* fs.makeDirectory(join(configDir, "plugins"), { recursive: true });
    const temporaryPath = `${pluginPath}.tmp-${process.pid}`;
    const source = yield* fs.readFile(
      fileURLToPath(new URL("./agent-hook/opencode.js", import.meta.url)),
    );
    yield* fs.writeFile(temporaryPath, source);
    yield* fs.rename(temporaryPath, pluginPath);
    return pluginPath;
  });

export const uninstallOpencodeHook = (
  home = homeDir(),
): Effect.Effect<boolean, PlatformError | AgentHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pluginPath = opencodePluginPath(home);
    const content = yield* fs.readFileString(pluginPath).pipe(Effect.result);
    if (Result.isFailure(content)) {
      if (content.failure.reason._tag === "NotFound") return false;
      return yield* content.failure;
    }
    if (!content.success.includes(MARKER)) {
      return yield* new AgentHookError({
        message: `refusing to remove unrecognised file at ${pluginPath}`,
      });
    }
    yield* fs.remove(pluginPath);
    return true;
  });

export const OPENCODE_PLUGIN_MARKER = MARKER;
