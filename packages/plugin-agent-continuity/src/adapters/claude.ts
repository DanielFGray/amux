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

export const claudeHookPath = (home = homeDir()) => `${home}/.claude/hooks/${INSTALL_NAME}`;

export const claudeSettingsPath = (home = homeDir()) => `${home}/.claude/settings.json`;

const installClaudeHook = (
  home = homeDir(),
): Effect.Effect<string, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const configDir = `${home}/.claude`;
    yield* requireConfigDirectory(configDir, "claude directory");
    const hookPath = claudeHookPath(home);
    const settingsPath = claudeSettingsPath(home);
    const source = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.readFile(fileURLToPath(new URL("../assets/claude.sh", import.meta.url))),
    );
    yield* writeManagedFile(hookPath, source, 0o755);

    const { value } = yield* readOrEmptyNestedHooksFile(settingsPath);
    const hooks = ensureNestedHooksMap(value);
    // Drop legacy amux/herdr action variants for this path, then ensure session.
    removeNestedCommandHooks(hooks, "SessionStart", [
      hookCommand(hookPath, "session"),
      hookCommand(hookPath, "idle"),
      hookCommand(hookPath),
    ]);
    ensureNestedCommandHook(hooks, "SessionStart", hookCommand(hookPath, "session"), 10, "*");
    yield* writeNestedHooksFile(settingsPath, value);
    return hookPath;
  });

const uninstallClaudeHook = (
  home = homeDir(),
): Effect.Effect<boolean, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const hookPath = claudeHookPath(home);
    const settingsPath = claudeSettingsPath(home);
    const fs = yield* FileSystem.FileSystem;
    const settings = yield* fs.readFileString(settingsPath).pipe(Effect.result);
    let updated = false;
    if (Result.isSuccess(settings)) {
      const { value } = yield* readOrEmptyNestedHooksFile(settingsPath);
      const hooks = ensureNestedHooksMap(value);
      updated = removeNestedCommandHooks(hooks, "SessionStart", [
        hookCommand(hookPath, "session"),
        hookCommand(hookPath, "idle"),
        hookCommand(hookPath),
      ]);
      if (updated) yield* writeNestedHooksFile(settingsPath, value);
    }
    const removed = yield* removeManagedFile(hookPath);
    return removed || updated;
  });

export const claudeAdapter: ForeignHarnessAdapter = {
  id: "claude",
  source: "amux:claude",
  label: "Claude Code",
  integrationVersion: INTEGRATION_VERSION,
  planResume: (ref) =>
    planResumeWithForm("amux:claude", "claude", ref, idOnly, {
      _tag: "flag",
      bin: "claude",
      flag: "--resume",
    }),
  hooks: { install: installClaudeHook, uninstall: uninstallClaudeHook },
};
