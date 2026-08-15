import { Stream } from "effect";
import type { CliRenderer } from "@opentui/core";
import type { PluginEnvironment } from "./host.ts";
import { createSessionViews } from "./session-views.tsx";
import { createPluginContributions } from "./contributions.ts";
import { createRegions } from "../ui/regions.tsx";
import { testPanelContext } from "../ui/test-panel.ts";

/**
 * A plugin environment for a check that cares about one field of it.
 *
 * The host's own type has no optional fields on purpose — a missing
 * collaborator there would be a registration silently dropped. A check is the
 * one caller that legitimately wants "everything, but only this part is real",
 * so the defaults live here rather than in the host.
 *
 * The registries are built here by default because they have to share one set
 * of contribution tables — regions built from tables nobody else reads would
 * file panels where nothing finds them. A check that needs the regions earlier
 * than the environment may hand them in, but must build them from the
 * `contributions` it hands in alongside.
 */
export function testPluginEnvironment(
  renderer: CliRenderer,
  parts: Partial<PluginEnvironment> = {},
): PluginEnvironment {
  const contributions = parts.contributions ?? createPluginContributions();
  return {
    panel: testPanelContext(),
    registerBinding: () => () => {},
    registerSettingsSection: () => () => {},
    frames: () => Stream.empty,
    sync: () => {},
    ...parts,
    contributions,
    regions: parts.regions ?? createRegions(renderer, contributions),
    sessionViews: parts.sessionViews ?? createSessionViews(contributions),
  };
}
