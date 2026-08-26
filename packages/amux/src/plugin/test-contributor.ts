import {
  createPluginContributions,
  type PluginContributions,
  type PluginInstance,
} from "./contributions.ts";

/**
 * Contribution tables with one contributor already committed.
 *
 * For a check about what a registry does rather than about which instance of a
 * plugin owns a name: anything registered through the returned owner is visible
 * immediately.
 */
export function testContributor(id = "test") {
  const contributions: PluginContributions = createPluginContributions();
  const owner: PluginInstance = { id, generation: 0 };
  contributions.commit(owner);
  return { contributions, owner };
}
