import { Effect, Result } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { fileURLToPath } from "node:url";
import {
  ForeignHarnessHookError,
  planResumeWithForm,
  type AgentSessionRefKind,
  type ForeignHarnessAdapter,
} from "@danielfgray/amux";
import {
  buildCodexConfigWithHooks,
  ensureNestedCommandHook,
  ensureNestedHooksMap,
  homeDir,
  hookCommand,
  readOrEmptyNestedHooksFile,
  removeManagedFile,
  removeNestedCommandHooks,
  requireConfigDirectory,
  writeManagedFile,
  writeNestedHooksFile,
} from "../hooks-install.ts";

const INTEGRATION_VERSION = 1;
const INSTALL_NAME = "amux-agent-state.sh";
const idOnly: ReadonlySet<AgentSessionRefKind> = new Set(["id"]);

export const codexHookPath = (home = homeDir()) => `${home}/.codex/${INSTALL_NAME}`;
export const codexHooksPath = (home = homeDir()) => `${home}/.codex/hooks.json`;
export const codexConfigPath = (home = homeDir()) => `${home}/.codex/config.toml`;

const installCodexHook = (
  home = homeDir(),
): Effect.Effect<string, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const configDir = `${home}/.codex`;
    yield* requireConfigDirectory(configDir, "codex config directory");
    const hookPath = codexHookPath(home);
    const hooksPath = codexHooksPath(home);
    const configPath = codexConfigPath(home);
    const source = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.readFile(fileURLToPath(new URL("../assets/codex.sh", import.meta.url))),
    );
    yield* writeManagedFile(hookPath, source, 0o755);

    const { value } = yield* readOrEmptyNestedHooksFile(hooksPath);
    const hooks = ensureNestedHooksMap(value);
    for (const action of ["session", "idle", "working", "blocked"] as const) {
      removeNestedCommandHooks(hooks, "SessionStart", [hookCommand(hookPath, action)]);
      removeNestedCommandHooks(hooks, "PermissionRequest", [hookCommand(hookPath, action)]);
      removeNestedCommandHooks(hooks, "UserPromptSubmit", [hookCommand(hookPath, action)]);
      removeNestedCommandHooks(hooks, "PreToolUse", [hookCommand(hookPath, action)]);
      removeNestedCommandHooks(hooks, "Stop", [hookCommand(hookPath, action)]);
    }
    ensureNestedCommandHook(hooks, "SessionStart", hookCommand(hookPath, "session"), 10);
    yield* writeNestedHooksFile(hooksPath, value);

    const fs = yield* FileSystem.FileSystem;
    const existingConfig = yield* fs
      .readFileString(configPath)
      .pipe(Effect.orElseSucceed(() => ""));
    const nextConfig = buildCodexConfigWithHooks(existingConfig);
    if (nextConfig !== existingConfig) yield* writeManagedFile(configPath, nextConfig);

    return hookPath;
  });

const uninstallCodexHook = (
  home = homeDir(),
): Effect.Effect<boolean, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const hookPath = codexHookPath(home);
    const hooksPath = codexHooksPath(home);
    const fs = yield* FileSystem.FileSystem;
    let updated = false;
    const existing = yield* fs.readFileString(hooksPath).pipe(Effect.result);
    if (Result.isSuccess(existing)) {
      const { value } = yield* readOrEmptyNestedHooksFile(hooksPath);
      const hooks = ensureNestedHooksMap(value);
      for (const event of [
        "SessionStart",
        "PermissionRequest",
        "UserPromptSubmit",
        "PreToolUse",
        "Stop",
      ] as const) {
        for (const action of ["session", "idle", "working", "blocked"] as const) {
          updated =
            removeNestedCommandHooks(hooks, event, [hookCommand(hookPath, action)]) || updated;
        }
      }
      if (updated) yield* writeNestedHooksFile(hooksPath, value);
    }
    const removed = yield* removeManagedFile(hookPath);
    return removed || updated;
  });

export const codexAdapter: ForeignHarnessAdapter = {
  id: "codex",
  source: "amux:codex",
  label: "Codex",
  integrationVersion: INTEGRATION_VERSION,
  planResume: (ref) =>
    planResumeWithForm("amux:codex", "codex", ref, idOnly, {
      _tag: "subcommand",
      bin: "codex",
      sub: "resume",
    }),
  hooks: { install: installCodexHook, uninstall: uninstallCodexHook },
};
