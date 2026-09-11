import { Effect } from "effect";
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
  homeDir,
  removeManagedFile,
  requireConfigDirectory,
  writeManagedFile,
} from "../hooks-install.ts";

const INTEGRATION_VERSION = 1;
const INSTALL_NAME = "amux-agent-state.js";
const idOnly: ReadonlySet<AgentSessionRefKind> = new Set(["id"]);

export const opencodePluginPath = (home = homeDir()) =>
  `${home}/.config/opencode/plugins/${INSTALL_NAME}`;

const installOpencodeHook = (
  home = homeDir(),
): Effect.Effect<string, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const configDir = `${home}/.config/opencode`;
    yield* requireConfigDirectory(configDir, "opencode config directory");
    const pluginPath = opencodePluginPath(home);
    const source = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.readFile(fileURLToPath(new URL("../assets/opencode.js", import.meta.url))),
    );
    yield* writeManagedFile(pluginPath, source);
    return pluginPath;
  });

const uninstallOpencodeHook = (
  home = homeDir(),
): Effect.Effect<boolean, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  removeManagedFile(opencodePluginPath(home));

export const opencodeAdapter: ForeignHarnessAdapter = {
  id: "opencode",
  source: "amux:opencode",
  label: "OpenCode",
  integrationVersion: INTEGRATION_VERSION,
  planResume: (ref) =>
    planResumeWithForm("amux:opencode", "opencode", ref, idOnly, {
      _tag: "flag",
      bin: "opencode",
      flag: "--session",
    }),
  hooks: { install: installOpencodeHook, uninstall: uninstallOpencodeHook },
};
