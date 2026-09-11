import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { cursorAdapter } from "./cursor.ts";
import { opencodeAdapter } from "./opencode.ts";
import type { ForeignHarnessAdapter } from "@danielfgray/amux";

/** Built-in foreign PTY harness adapters shipped with this plugin. */
export const adapters: readonly ForeignHarnessAdapter[] = [
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  opencodeAdapter,
];

export { claudeAdapter, codexAdapter, cursorAdapter, opencodeAdapter };
