import type { KeyEvent } from "@opentui/core";
import type { CommandsChrome } from "../../plugin/chrome.ts";

export function promptOverlayKeys(chrome: CommandsChrome, event: KeyEvent): boolean {
  const request = chrome.prompt();
  if (!request) return true;
  // A notice is a message, not a form: nothing is focused to hand the
  // key to, so every key is consumed here and enter/escape dismiss it.
  if (request.notice) {
    if (event.name === "escape" || event.name === "return" || event.name === "enter") {
      request.resolve(null);
    }
    return true;
  }
  // Escape cancels; everything else belongs to the focused input, so
  // leave the event alone and let focus routing deliver it.
  if (event.name === "escape") {
    request.resolve(null);
    return true;
  }
  return false;
}

export function errorOverlayKeys(chrome: CommandsChrome, event: KeyEvent): boolean {
  if (event.name !== "escape") return false;
  chrome.clearCommandError();
  return true;
}
