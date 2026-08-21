import { Stream } from "effect";
import type { CliRenderer } from "@opentui/core";
import type { PluginEnvironment } from "./host.ts";
import { createSessionViews } from "./session-views.tsx";
import { createPluginContributions } from "./contributions.ts";
import { createRegions } from "../ui/regions.tsx";
import { testPanelContext } from "../ui/test-panel.ts";
import type { SpawnProvider } from "./types.ts";
import type { Regions } from "../ui/regions.tsx";
import type { SessionViews } from "./session-views.tsx";
import type { PluginRegistries } from "./services.ts";
import type { OptionSpec } from "../options.ts";

type TestEnvironmentParts = Omit<Partial<PluginEnvironment>, "registries"> & {
  readonly regions?: Regions;
  readonly sessionViews?: SessionViews;
  readonly registries?: Partial<PluginRegistries>;
};

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
  parts: TestEnvironmentParts = {},
): PluginEnvironment {
  const contributions = parts.contributions ?? createPluginContributions();
  const regions = parts.regions ?? createRegions(renderer, contributions);
  const sessionViews = parts.sessionViews ?? createSessionViews(contributions);
  const {
    regions: _regions,
    sessionViews: _sessionViews,
    registries: registryOverrides,
    ...environment
  } = parts;
  const bindings = contributions.table<unknown>();
  const settings = contributions.table<unknown>();
  const options = contributions.table<OptionSpec>();
  const spawnProviders = contributions.table<() => SpawnProvider>();
  return {
    panel: testPanelContext(),
    frames: () => Stream.empty,
    sync: () => {},
    registries: {
      regions,
      sessionViews,
      bindings: (owner, binding) => bindings.add(owner, binding.name, binding),
      settings: (owner, section) => settings.add(owner, section.id, section),
      options: (owner, name, spec) => options.add(owner, name, spec),
      spawnProviders: (owner, id, provider) => spawnProviders.add(owner, id, provider),
      spawnProvider: (id) => spawnProviders.get(id)?.(),
      ...registryOverrides,
    },
    ...environment,
    contributions,
  };
}
