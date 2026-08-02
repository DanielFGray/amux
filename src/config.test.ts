import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONFIG_LIMITS, DEFAULT_CONFIG, decodeConfig, loadConfig, saveConfig } from "./config.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "herdr-config-"))
  temporaryDirectories.push(directory)
  return join(directory, "config.json")
}

test("malformed fields cannot inject runtime config types or unbounded dimensions", () => {
  const config = decodeConfig({
    sidebar: { width: 999, open: "yes", agentsOnly: null },
    behaviour: { scrollRows: 999, shell: 42 },
    appearance: { paneGap: 999, whichKeyHints: [], whichKeyDelay: 999 },
    keys: { leader: 7, bindings: { safe: ["ctrl+x", 4], "__proto__": ["ctrl+p"] } },
  })

  expect(config).toEqual({
    ...DEFAULT_CONFIG,
    sidebar: { ...DEFAULT_CONFIG.sidebar, width: CONFIG_LIMITS.sidebarWidth.max },
    behaviour: { ...DEFAULT_CONFIG.behaviour, scrollRows: CONFIG_LIMITS.scrollRows.max },
    appearance: {
      ...DEFAULT_CONFIG.appearance,
      paneGap: CONFIG_LIMITS.paneGap.max,
      whichKeyDelay: CONFIG_LIMITS.whichKeyDelay.max,
    },
    keys: { leader: DEFAULT_CONFIG.keys.leader, bindings: { safe: ["ctrl+x"], "__proto__": ["ctrl+p"] } },
  })
})

test("missing fields in an older config receive current defaults", () => {
  expect(decodeConfig({ sidebar: { open: false }, behaviour: { shell: "zsh" } })).toEqual({
    ...DEFAULT_CONFIG,
    sidebar: { ...DEFAULT_CONFIG.sidebar, open: false },
    behaviour: { ...DEFAULT_CONFIG.behaviour, shell: "zsh" },
  })
})

test("valid config survives save and load", async () => {
  const path = await temporaryConfig()
  const config = decodeConfig({
    sidebar: { width: 42, open: false, agentsOnly: true },
    behaviour: { scrollRows: 7, shell: "zsh" },
    appearance: { paneGap: 2, whichKeyHints: false, whichKeyDelay: 3 },
    keys: { leader: "ctrl+b", bindings: { "app.quit": ["<leader>q"] } },
  })

  await saveConfig(config, path)
  expect(await loadConfig(path)).toEqual(config)
})

test("invalid JSON falls back without throwing", async () => {
  const path = await temporaryConfig()
  await Bun.write(path, "{not json")

  await expect(loadConfig(path)).resolves.toEqual(DEFAULT_CONFIG)
})
