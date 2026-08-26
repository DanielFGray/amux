import { RGBA } from "@opentui/core";

/** Catppuccin Mocha. Kept as one table so the imperative panes and the Solid
 *  chrome cannot drift into two slightly different palettes. */
export const theme = {
  base: RGBA.fromInts(30, 30, 46, 255),
  mantle: RGBA.fromInts(24, 24, 37, 255),
  surface0: RGBA.fromInts(49, 50, 68, 255),
  surface1: RGBA.fromInts(69, 71, 90, 255),
  overlay0: RGBA.fromInts(88, 91, 112, 255),
  overlay1: RGBA.fromInts(127, 132, 151, 255),
  subtext0: RGBA.fromInts(166, 173, 200, 255),
  text: RGBA.fromInts(205, 214, 244, 255),
  blue: RGBA.fromInts(137, 180, 250, 255),
  mauve: RGBA.fromInts(203, 166, 247, 255),
  green: RGBA.fromInts(166, 227, 161, 255),
  red: RGBA.fromInts(243, 139, 168, 255),
  peach: RGBA.fromInts(250, 179, 135, 255),
  yellow: RGBA.fromInts(249, 226, 175, 255),
} as const;
