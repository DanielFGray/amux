import { RGBA } from "@opentui/core";
import { createSignal } from "solid-js";

/**
 * Semantic chrome colors shared by Solid UI, imperative panes, the editor,
 * and highlight token styles. Kept as one live table so those surfaces cannot
 * drift into two slightly different palettes.
 *
 * Two kinds of theme:
 * - `ansi` (default): indexed / default-slot colors so the terminal's 16-color
 *   palette owns the look (OpenTUI `RGBA.fromIndex` / `defaultForeground` /
 *   `defaultBackground`).
 * - named truecolor tables (`catppuccin-mocha`, …): fixed RGB, for when the
 *   user opts into a specific look.
 *
 * Borrowed from opencode's theme switcher (named themes + live resolve) and
 * OpenTUI's indexed color intent — not from opencode's OSC4→RGB "system"
 * snapshot, which paints truecolor and stops tracking palette edits.
 */

export type ThemeColors = {
  base: RGBA;
  mantle: RGBA;
  surface0: RGBA;
  surface1: RGBA;
  overlay0: RGBA;
  overlay1: RGBA;
  subtext0: RGBA;
  text: RGBA;
  blue: RGBA;
  mauve: RGBA;
  green: RGBA;
  red: RGBA;
  peach: RGBA;
  yellow: RGBA;
  /** DiffRenderable wash / gutter colors (harness DiffBlock). */
  diffAddedBg: RGBA;
  diffRemovedBg: RGBA;
  diffContextBg: RGBA;
  diffHighlightAdded: RGBA;
  diffHighlightRemoved: RGBA;
  diffLineNumber: RGBA;
  diffAddedLineNumberBg: RGBA;
  diffRemovedLineNumberBg: RGBA;
};

/** Blend `overlay` onto `base` by `alpha` — used for truecolor diff washes.
 *  Cite: opencode `tint` in tui/context/theme.tsx. */
const tint = (base: RGBA, overlay: RGBA, alpha: number): RGBA => {
  const [br, bg, bb] = base.toInts();
  const [or, og, ob] = overlay.toInts();
  return RGBA.fromInts(
    Math.round(br + (or - br) * alpha),
    Math.round(bg + (og - bg) * alpha),
    Math.round(bb + (ob - bb) * alpha),
  );
};

/** Indexed default: roles map onto ANSI slots / default fg+bg. */
const ANSI: ThemeColors = {
  base: RGBA.defaultBackground(),
  mantle: RGBA.fromIndex(0),
  surface0: RGBA.fromIndex(8),
  surface1: RGBA.fromIndex(8),
  overlay0: RGBA.fromIndex(8),
  overlay1: RGBA.fromIndex(7),
  subtext0: RGBA.fromIndex(7),
  text: RGBA.defaultForeground(),
  blue: RGBA.fromIndex(12),
  mauve: RGBA.fromIndex(13),
  green: RGBA.fromIndex(10),
  red: RGBA.fromIndex(9),
  peach: RGBA.fromIndex(11),
  yellow: RGBA.fromIndex(11),
  // Diff washes stay indexed so ansi chrome never forces truecolor SGR.
  diffAddedBg: RGBA.fromIndex(2),
  diffRemovedBg: RGBA.fromIndex(1),
  diffContextBg: RGBA.defaultBackground(),
  diffHighlightAdded: RGBA.fromIndex(10),
  diffHighlightRemoved: RGBA.fromIndex(9),
  diffLineNumber: RGBA.fromIndex(8),
  diffAddedLineNumberBg: RGBA.fromIndex(2),
  diffRemovedLineNumberBg: RGBA.fromIndex(1),
};

/** Catppuccin Mocha — the previous hardcoded chrome palette. */
const mochaBase = RGBA.fromInts(30, 30, 46, 255);
const mochaGreen = RGBA.fromInts(166, 227, 161, 255);
const mochaRed = RGBA.fromInts(243, 139, 168, 255);
const mochaSurface0 = RGBA.fromInts(49, 50, 68, 255);

const CATPPUCCIN_MOCHA: ThemeColors = {
  base: mochaBase,
  mantle: RGBA.fromInts(24, 24, 37, 255),
  surface0: mochaSurface0,
  surface1: RGBA.fromInts(69, 71, 90, 255),
  overlay0: RGBA.fromInts(88, 91, 112, 255),
  overlay1: RGBA.fromInts(127, 132, 151, 255),
  subtext0: RGBA.fromInts(166, 173, 200, 255),
  text: RGBA.fromInts(205, 214, 244, 255),
  blue: RGBA.fromInts(137, 180, 250, 255),
  mauve: RGBA.fromInts(203, 166, 247, 255),
  green: mochaGreen,
  red: mochaRed,
  peach: RGBA.fromInts(250, 179, 135, 255),
  yellow: RGBA.fromInts(249, 226, 175, 255),
  diffAddedBg: tint(mochaBase, mochaGreen, 0.22),
  diffRemovedBg: tint(mochaBase, mochaRed, 0.22),
  diffContextBg: mochaSurface0,
  diffHighlightAdded: mochaGreen,
  diffHighlightRemoved: mochaRed,
  diffLineNumber: RGBA.fromInts(127, 132, 151, 255),
  diffAddedLineNumberBg: tint(mochaSurface0, mochaGreen, 0.22),
  diffRemovedLineNumberBg: tint(mochaSurface0, mochaRed, 0.22),
};

export const THEMES = {
  ansi: ANSI,
  "catppuccin-mocha": CATPPUCCIN_MOCHA,
} as const satisfies Record<string, ThemeColors>;

export type ThemeName = keyof typeof THEMES;

export const DEFAULT_THEME_NAME: ThemeName = "ansi";

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

const colors: ThemeColors = { ...THEMES[DEFAULT_THEME_NAME] };
let active: ThemeName = DEFAULT_THEME_NAME;

/** Solid tracks theme reads through this revision so `theme.base` in JSX
 *  styles re-evaluate when {@link setTheme} runs — without forcing every
 *  call site onto a context hook. */
const [revision, bump] = createSignal(0);

const listeners = new Set<(name: ThemeName) => void>();

/**
 * Live theme table. Property access inside a Solid reactive scope depends on
 * the theme revision; outside Solid (highlight, tests) it just returns the
 * current RGBA for that role.
 */
export const theme: ThemeColors = new Proxy(colors, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && Object.hasOwn(target, prop)) {
      revision();
      return Reflect.get(target, prop, receiver);
    }
    return Reflect.get(target, prop, receiver);
  },
}) as ThemeColors;

export function themeName(): ThemeName {
  return active;
}

export function hasTheme(name: string): name is ThemeName {
  return Object.hasOwn(THEMES, name);
}

/** Apply a named theme. Returns false when the name is unknown. */
export function setTheme(name: string): boolean {
  if (!hasTheme(name)) return false;
  if (active === name) return true;
  active = name;
  Object.assign(colors, THEMES[name]);
  bump((n) => n + 1);
  for (const listener of listeners) listener(name);
  return true;
}

/** Notify when the live table changes. Returns an unsubscribe. */
export function onThemeChange(listener: (name: ThemeName) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
