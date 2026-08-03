import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DEFAULT_LEADER, type Keys } from "./bindings.ts"
import { type OptionDeltas } from "./options.ts"

/**
 * The file, and nothing else.
 *
 * Both halves record only what the user changed: options.ts explains why for
 * settings, and the same rule has always held for bindings. What an option
 * *is* — its type, default, bounds and description — lives in options.ts, so
 * adding one does not touch this module.
 */
export interface Config {
  options: OptionDeltas
  /** Prefix key and per-command overrides. Only commands the user has actually
   * rebound appear here, so the defaults stay free to change. */
  keys: Keys
}

export const DEFAULT_CONFIG: Config = {
  options: {},
  keys: { leader: DEFAULT_LEADER, bindings: {} },
}

const CONFIG_DIR =
  process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config")
export const CONFIG_PATH = join(CONFIG_DIR, "amux", "config.json")

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Read a loaded file into a Config.
 *
 * Option values are NOT validated here. They are stored as written and resolved
 * against the table on read (resolveOptions), which is what lets an entry
 * belonging to a name this build does not know survive a save instead of being
 * dropped by the decoder that failed to recognise it.
 */
export function decodeConfig(loaded: unknown): Config {
  if (!isRecord(loaded)) return structuredClone(DEFAULT_CONFIG)
  return {
    options: isRecord(loaded.options) ? { ...loaded.options } : {},
    keys: sanitizeKeys(loaded.keys),
  }
}

/** Keep hand-edited key bindings from breaking keymap compilation. */
function sanitizeKeys(keys: unknown): Keys {
  const raw = isRecord(keys) ? keys : {}
  const leader = typeof raw.leader === "string" && raw.leader.trim() ? raw.leader : DEFAULT_LEADER
  const bindings: Record<string, string[]> = {}
  const rawBindings = isRecord(raw.bindings) ? raw.bindings : {}
  for (const [name, value] of Object.entries(rawBindings)) {
    // An empty array is meaningful: it deliberately leaves a command unbound.
    if (!Array.isArray(value)) continue
    Object.defineProperty(bindings, name, {
      value: value.filter((key): key is string => typeof key === "string" && key.length > 0),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return { leader, bindings }
}

export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return structuredClone(DEFAULT_CONFIG)
    const raw = await file.json()
    if (!isRecord(raw)) {
      console.warn(`Ignoring malformed config at ${path}: expected a JSON object`)
      return structuredClone(DEFAULT_CONFIG)
    }
    return decodeConfig(raw)
  } catch (error) {
    console.warn(`Ignoring unreadable config at ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return structuredClone(DEFAULT_CONFIG)
  }
}

export async function saveConfig(config: Config, path = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(config, null, 2) + "\n")
}
