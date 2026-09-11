import { Context } from "effect";

/**
 * The two modals that share one slot: opening either closes the other.
 * Host-provided and stable across plugin reload — paper §6.1 reification of
 * a shared location so settings/commands fibers do not close over `buildApp`.
 */
export type OverlayKind = "none" | "settings" | "palette";

export interface OverlayService {
  readonly get: () => OverlayKind;
  readonly set: (kind: OverlayKind) => void;
  readonly is: (kind: OverlayKind) => boolean;
}

/** @effect-leakable-service */
export class OverlayTag extends Context.Service<OverlayTag, OverlayService>()("amux/Overlay") {}

export const makeOverlay = (
  get: () => OverlayKind,
  set: (kind: OverlayKind) => void,
): OverlayService => ({
  get,
  set,
  is: (kind) => get() === kind,
});
