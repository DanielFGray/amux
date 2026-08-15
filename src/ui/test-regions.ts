import type { CliRenderer } from "@opentui/core";
import { createRegions, type Regions } from "./regions.tsx";
import { testContributor } from "../plugin/test-contributor.ts";

/**
 * Regions with one contributor, already committed.
 *
 * For a check about the layout rather than about who owns what: every panel
 * registered through the returned owner is on screen straight away.
 */
export function testRegions(renderer: CliRenderer) {
  const { contributions, owner } = testContributor();
  const regions: Regions = createRegions(renderer, contributions);
  return { regions, owner };
}
