import { Stream } from "effect";
import type { PluginEnvironment } from "./host.ts";
import { createSessionViews } from "./session-views.tsx";
import { testPanelContext } from "../ui/test-panel.ts";

/**
 * A plugin environment for a check that cares about one field of it.
 *
 * The host's own type has no optional fields on purpose — a missing
 * collaborator there would be a registration silently dropped. A check is the
 * one caller that legitimately wants "everything, but only this part is real",
 * so the defaults live here rather than in the host.
 */
export function testPluginEnvironment(
  parts: Pick<PluginEnvironment, "regions"> & Partial<PluginEnvironment>,
): PluginEnvironment {
  return {
    panel: testPanelContext(),
    sessionViews: createSessionViews(),
    registerBinding: () => () => {},
    frames: () => Stream.empty,
    sync: () => {},
    ...parts,
  };
}
