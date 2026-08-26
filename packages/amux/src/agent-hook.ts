import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INSTALL_NAME = "amux-agent-state.js";
const MARKER = "AMUX_AGENT_STATE_PLUGIN=1";

export const opencodePluginPath = (home = process.env.HOME ?? ".") =>
  join(home, ".config", "opencode", "plugins", INSTALL_NAME);

export async function installOpencodeHook(home = process.env.HOME ?? "."): Promise<string> {
  const configDir = join(home, ".config", "opencode");
  const pluginPath = opencodePluginPath(home);
  try {
    if (!(await stat(configDir)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`opencode config directory not found at ${configDir}`);
  }

  await mkdir(join(configDir, "plugins"), { recursive: true });
  const temporaryPath = `${pluginPath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPath,
    await readFile(new URL("./agent-hook/opencode.js", import.meta.url)),
  );
  await rename(temporaryPath, pluginPath);
  return pluginPath;
}

export async function uninstallOpencodeHook(home = process.env.HOME ?? "."): Promise<boolean> {
  const pluginPath = opencodePluginPath(home);
  try {
    const content = await readFile(pluginPath, "utf8");
    if (!content.includes(MARKER)) {
      throw new Error(`refusing to remove unrecognised file at ${pluginPath}`);
    }
    await rm(pluginPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export const OPENCODE_PLUGIN_MARKER = MARKER;
