/**
 * Convert `@opentui/core` KeyEvent → engine Key once at the editor edge.
 * Drops release events; press and repeat both feed the reducer.
 */
import type { KeyEvent } from "@opentui/core";
import type { Key } from "@danielfgray/amux-vim";

export const keyFromEvent = (event: KeyEvent): Key | null => {
  if (event.eventType === "release") return null;
  return {
    name: event.name,
    sequence: event.sequence,
    shift: event.shift,
    ctrl: event.ctrl,
    meta: event.meta,
    option: event.option,
  };
};
