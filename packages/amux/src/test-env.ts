/** @effect-diagnostics *:skip-file -- runs before any Effect runtime exists;
 *  see the comment below. */
/**
 * `[test].preload` — runs before any test file imports config.ts, whose
 * CONFIG_DIR/CONFIG_PATH resolve from XDG_CONFIG_HOME once at module load.
 *
 * Without this, every test process (and every CLI subprocess a test spawns,
 * which inherits process.env) reads the developer's real
 * ~/.config/amux/config.json — a real config with real plugins configured by
 * absolute path outside that directory, which loader.ts refuses and warns
 * about on every load. That made most of the suite either depend on
 * whatever plugins happen to be configured on the machine running it, or
 * spam "Ignoring plugin outside config directory" warnings, or both. An
 * empty, isolated directory makes `loadConfig()` fall back to defaults
 * (no plugins) everywhere, so tests see the same config regardless of the
 * developer's local setup.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "amux-test-config-"));
