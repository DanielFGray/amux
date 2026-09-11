import type { KeyEvent } from "@opentui/core";
import type { OverlayService } from "../../plugin/overlay.ts";
import type { CommandsChrome } from "../../plugin/chrome.ts";

export function paletteKey(chrome: CommandsChrome, event: KeyEvent): boolean {
  const count = chrome.entries().length;
  switch (event.name) {
    case "up":
      if (count) chrome.setSelected((s) => Math.max(0, s - 1));
      return true;
    case "down":
      if (count) chrome.setSelected((s) => Math.min(count - 1, s + 1));
      return true;
    case "pageup":
      if (count) chrome.setSelected((s) => Math.max(0, s - 10));
      return true;
    case "pagedown":
      if (count) chrome.setSelected((s) => Math.min(count - 1, s + 10));
      return true;
  }
  // Let text and Enter reach the focused input renderable.
  return false;
}

export function paletteOverlayKeys(
  chrome: CommandsChrome,
  overlay: OverlayService,
  event: KeyEvent,
): boolean {
  if (event.name === "escape") {
    overlay.set("none");
    return true;
  }
  return paletteKey(chrome, event);
}
