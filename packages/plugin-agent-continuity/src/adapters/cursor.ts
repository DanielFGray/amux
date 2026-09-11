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
  ensureHooksObject,
  ensureSimpleCommandHook,
  homeDir,
  hookCommand,
  readOrEmptyJsonObject,
  removeManagedFile,
  removeSimpleCommandHook,
  requireConfigDirectory,
  writeJsonObject,
  writeManagedFile,
} from "../hooks-install.ts";

const INTEGRATION_VERSION = 1;
const INSTALL_NAME = "amux-agent-state.sh";
const idOnly: ReadonlySet<AgentSessionRefKind> = new Set(["id"]);

/** Events that may have carried a prior amux session hook — strip on install/uninstall. */
const CURSOR_SESSION_HOOK_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "beforeShellExecution",
  "beforeMCPExecution",
  "stop",
  "sessionEnd",
] as const;

export const cursorHookPath = (home = homeDir()) => `${home}/.cursor/${INSTALL_NAME}`;
export const cursorHooksPath = (home = homeDir()) => `${home}/.cursor/hooks.json`;

const installCursorHook = (
  home = homeDir(),
): Effect.Effect<string, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const configDir = `${home}/.cursor`;
    yield* requireConfigDirectory(configDir, "cursor config directory");
    const hookPath = cursorHookPath(home);
    const hooksPath = cursorHooksPath(home);
    const source = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.readFile(fileURLToPath(new URL("../assets/cursor.sh", import.meta.url))),
    );
    yield* writeManagedFile(hookPath, source, 0o755);

    const { value } = yield* readOrEmptyJsonObject(hooksPath);
    if (value.version === undefined) value.version = 1;
    const hooks = ensureHooksObject(value);
    const sessionCommand = hookCommand(hookPath, "session");
    for (const event of CURSOR_SESSION_HOOK_EVENTS) {
      removeSimpleCommandHook(hooks, event, sessionCommand);
    }
    ensureSimpleCommandHook(hooks, "sessionStart", sessionCommand);
    yield* writeJsonObject(hooksPath, value);
    return hookPath;
  });

const uninstallCursorHook = (
  home = homeDir(),
): Effect.Effect<boolean, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const hookPath = cursorHookPath(home);
    const hooksPath = cursorHooksPath(home);
    const fs = yield* FileSystem.FileSystem;
    let updated = false;
    const existing = yield* fs.readFileString(hooksPath).pipe(Effect.result);
    if (Result.isSuccess(existing)) {
      const { value } = yield* readOrEmptyJsonObject(hooksPath);
      const hooks = ensureHooksObject(value);
      const sessionCommand = hookCommand(hookPath, "session");
      for (const event of CURSOR_SESSION_HOOK_EVENTS) {
        updated = removeSimpleCommandHook(hooks, event, sessionCommand) || updated;
      }
      if (updated) yield* writeJsonObject(hooksPath, value);
    }
    const removed = yield* removeManagedFile(hookPath);
    return removed || updated;
  });

/**
 * Cursor Agent CLI (`cursor-agent` / `agent`) as a foreign PTY harness.
 * Resume argv and hooks.json self-report mirror herdr's cursor integration;
 * provider auth stays on Cursor's own login / CURSOR_API_KEY.
 */
export const cursorAdapter: ForeignHarnessAdapter = {
  id: "cursor",
  source: "amux:cursor",
  label: "Cursor Agent",
  integrationVersion: INTEGRATION_VERSION,
  planResume: (ref) =>
    planResumeWithForm("amux:cursor", "cursor", ref, idOnly, {
      _tag: "flag",
      bin: "cursor-agent",
      flag: "--resume",
    }),
  hooks: { install: installCursorHook, uninstall: uninstallCursorHook },
};
