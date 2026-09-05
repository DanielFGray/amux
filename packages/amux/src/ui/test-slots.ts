import type { CliRenderer } from "@opentui/core";
import { createSlots, type Slots } from "./slots.ts";
import { testContributor } from "../plugin/test-contributor.ts";

/**
 * Slots with one contributor, already committed.
 *
 * For a check about the layout rather than about who owns what: every panel
 * registered through the returned owner is on screen straight away.
 */
export function testSlots(renderer: CliRenderer) {
  const { contributions, owner } = testContributor();
  const slots: Slots = createSlots(renderer, contributions);
  return { slots, owner };
}
