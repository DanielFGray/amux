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
    /**
     * Pane separation mode: zero merges shared borders, one restores each pane's
     * border without widening the divider, and larger values add cells.
     */
    paneGap: number
    /** Whether the transient which-key panel is shown after a prefix. */
    whichKeyHints: boolean
    /** Seconds of inactivity before the which-key panel appears. */
    whichKeyDelay: number
  }
  /** Prefix key and per-command overrides. Only commands the user has actually
   * rebound appear here, so the defaults stay free to change. */
  keys: Keys
}

export const DEFAULT_CONFIG: Config = {
  sidebar: { width: 30, open: true, agentsOnly: false },
  behaviour: { scrollRows: 3, shell: "" },
  appearance: { paneGap: 0, whichKeyHints: true, whichKeyDelay: 0 },
  keys: { leader: DEFAULT_LEADER, bindings: {} },
}

export const CONFIG_LIMITS = {
  sidebarWidth: { min: 16, max: 60 },
  scrollRows: { min: 1, max: 20 },
  paneGap: { min: 0, max: 8 },
  whichKeyDelay: { min: 0, max: 5 },
} as const

const CONFIG_DIR =
  process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config")
export const CONFIG_PATH = join(CONFIG_DIR, "opentui-herdr", "config.json")

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/** Decode known fields so old files get defaults and unknown values stay inert. */
export function decodeConfig(loaded: unknown): Config {
  if (!isRecord(loaded)) return structuredClone(DEFAULT_CONFIG)

  const sidebar = isRecord(loaded.sidebar) ? loaded.sidebar : {}
  const behaviour = isRecord(loaded.behaviour) ? loaded.behaviour : {}
  const appearance = isRecord(loaded.appearance) ? loaded.appearance : {}
  return {
    sidebar: {
      width: boundedNumber(sidebar.width, DEFAULT_CONFIG.sidebar.width, CONFIG_LIMITS.sidebarWidth.min, CONFIG_LIMITS.sidebarWidth.max),
      open: typeof sidebar.open === "boolean" ? sidebar.open : DEFAULT_CONFIG.sidebar.open,
      agentsOnly: typeof sidebar.agentsOnly === "boolean" ? sidebar.agentsOnly : DEFAULT_CONFIG.sidebar.agentsOnly,
    },
    behaviour: {
      scrollRows: boundedNumber(behaviour.scrollRows, DEFAULT_CONFIG.behaviour.scrollRows, CONFIG_LIMITS.scrollRows.min, CONFIG_LIMITS.scrollRows.max),
      shell: typeof behaviour.shell === "string" ? behaviour.shell : DEFAULT_CONFIG.behaviour.shell,
    },
    appearance: {
      paneGap: boundedNumber(appearance.paneGap, DEFAULT_CONFIG.appearance.paneGap, CONFIG_LIMITS.paneGap.min, CONFIG_LIMITS.paneGap.max),
      whichKeyHints: typeof appearance.whichKeyHints === "boolean" ? appearance.whichKeyHints : DEFAULT_CONFIG.appearance.whichKeyHints,
      whichKeyDelay: boundedNumber(appearance.whichKeyDelay, DEFAULT_CONFIG.appearance.whichKeyDelay, CONFIG_LIMITS.whichKeyDelay.min, CONFIG_LIMITS.whichKeyDelay.max),
    },
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

/**
 * Live copy of the settings that imperative code reads at the point of use.
 * Kept in sync by applyConfig() whenever the config changes.
 */
export const runtime = {
  scrollRows: DEFAULT_CONFIG.behaviour.scrollRows,
  paneGap: DEFAULT_CONFIG.appearance.paneGap,
}

export function applyConfig(config: Config): void {
  const decoded = decodeConfig(config)
  runtime.scrollRows = decoded.behaviour.scrollRows
  runtime.paneGap = decoded.appearance.paneGap
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
