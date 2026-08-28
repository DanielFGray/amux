/**
 * Test helpers for plugins, kept off the authoring path.
 *
 * These are as public as the API — a plugin cannot be tested without them — but
 * a plugin author writing a plugin should never meet them by autocomplete. That
 * is the whole reason they sit behind their own subpath rather than in `amux`.
 */

export { testEffect } from "./test-effect.ts";
export { waitFor } from "./test-wait.ts";
export { testPanelContext } from "./ui/test-panel.ts";
export { testPluginEnvironment } from "./plugin/test-environment.ts";

// Standing up a real region tree is a test-only need: the app builds its own.
export { createRegions, type Regions } from "./ui/regions.tsx";
