import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DEFAULT_LEADER, type Keys } from "./bindings.ts"

export interface Config {
  sidebar: {
    width: number
    /** Whether the sidebar starts open. */
    open: boolean
    /** Whether to show only panes running a recognised agent CLI. */
    agentsOnly: boolean
  }
  behaviour: {
    /** Rows a wheel notch scrolls in a pane's scrollback. */
    scrollRows: number
    /** Shell used for new agents. Empty means $SHELL. */
    shell: string
  }
  appearance: {
    /** Cells between adjacent pane borders. Zero keeps merged dividers. */
    paneGap: number
  }
  /** Prefix key and per-command overrides. Only commands the user has actually
   *  rebound appear here, so the defaults stay free to change. */
  keys: Keys
}

export const DEFAULT_CONFIG: Config = {
  sidebar: { width: 30, open: true, agentsOnly: false },
  behaviour: { scrollRows: 3, shell: "" },
  appearance: { paneGap: 0 },
  keys: { leader: DEFAULT_LEADER, bindings: {} },
}

const CONFIG_DIR =
  process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config")
export const CONFIG_PATH = join(CONFIG_DIR, "opentui-herdr", "config.json")

/** Merge one level deep so a config written by an older version keeps working
 *  when new sections or keys are added. */
function merge(base: Config, loaded: unknown): Config {
  if (!loaded || typeof loaded !== "object") return base
  const out = structuredClone(base)
  for (const [section, values] of Object.entries(loaded as Record<string, unknown>)) {
    if (!(section in out) || !values || typeof values !== "object") continue
    Object.assign((out as Record<string, any>)[section], values)
  }
  out.keys = sanitizeKeys(out.keys)
  return out
}

/**
 * Keep a hand-edited `keys` section from breaking the keymap.
 *
 * This is the one section people will write by hand, and the values go straight
 * into binding compilation — a number where a sequence belongs would otherwise
 * take the app out at startup. Anything unrecognisable falls back to the
 * default rather than being reported: the file is not a program.
 */
function sanitizeKeys(keys: unknown): Keys {
  const raw = (keys ?? {}) as Partial<Keys>
  const leader = typeof raw.leader === "string" && raw.leader.trim() ? raw.leader : DEFAULT_LEADER
  const bindings: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(raw.bindings ?? {})) {
    // An empty array is meaningful — it is how a command is left unbound.
    if (!Array.isArray(value)) continue
    bindings[name] = value.filter((key): key is string => typeof key === "string" && key.length > 0)
  }
  return { leader, bindings }
}

/**
 * Live copy of the settings that imperative code reads at the point of use.
 *
 * The Solid chrome takes config through props, but a pane is a plain
 * Renderable several layers below any component — threading a preference down
 * to it would mean plumbing config through Workspace and Space for no gain.
 * Kept in sync by applyConfig() whenever the config changes.
 */
export const runtime = {
  scrollRows: DEFAULT_CONFIG.behaviour.scrollRows,
  paneGap: DEFAULT_CONFIG.appearance.paneGap,
}

export function applyConfig(config: Config): void {
  runtime.scrollRows = config.behaviour.scrollRows
  runtime.paneGap = Math.max(0, Math.floor(config.appearance.paneGap))
}

export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return structuredClone(DEFAULT_CONFIG)
    return merge(DEFAULT_CONFIG, await file.json())
  } catch {
    // A corrupt config must not stop the app from starting.
    return structuredClone(DEFAULT_CONFIG)
  }
}

export async function saveConfig(config: Config, path = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(config, null, 2) + "\n")
}
