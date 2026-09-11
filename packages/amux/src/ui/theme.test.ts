import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import {
  DEFAULT_THEME_NAME,
  THEME_NAMES,
  hasTheme,
  onThemeChange,
  setTheme,
  theme,
  themeName,
} from "./theme.ts";

test("default theme is ansi and paints indexed / default slots", () => {
  setTheme(DEFAULT_THEME_NAME);
  expect(themeName()).toBe("ansi");
  expect(theme.base.intent).toBe("default");
  expect(theme.text.intent).toBe("default");
  expect(theme.blue.intent).toBe("indexed");
  expect(theme.blue.slot).toBe(12);
  expect(theme.red.slot).toBe(9);
});

test("catppuccin-mocha is truecolor RGB", () => {
  expect(setTheme("catppuccin-mocha")).toBe(true);
  expect(themeName()).toBe("catppuccin-mocha");
  expect(theme.base.intent).toBe("rgb");
  expect(theme.base.equals(RGBA.fromInts(30, 30, 46, 255))).toBe(true);
  expect(theme.mauve.equals(RGBA.fromInts(203, 166, 247, 255))).toBe(true);
  setTheme("ansi");
});

test("unknown theme names are refused", () => {
  expect(hasTheme("nonesuch")).toBe(false);
  expect(setTheme("nonesuch")).toBe(false);
  expect(themeName()).toBe("ansi");
});

test("setTheme notifies listeners and live theme reads update", () => {
  const seen: string[] = [];
  const stop = onThemeChange((name) => seen.push(name));
  expect(setTheme("catppuccin-mocha")).toBe(true);
  expect(seen).toEqual(["catppuccin-mocha"]);
  expect(theme.base.equals(RGBA.fromInts(30, 30, 46, 255))).toBe(true);
  expect(setTheme("ansi")).toBe(true);
  expect(seen).toEqual(["catppuccin-mocha", "ansi"]);
  stop();
  expect(setTheme("catppuccin-mocha")).toBe(true);
  expect(seen).toEqual(["catppuccin-mocha", "ansi"]);
  setTheme("ansi");
});

test("THEME_NAMES lists every built-in", () => {
  expect(THEME_NAMES).toEqual(["ansi", "catppuccin-mocha"]);
});
