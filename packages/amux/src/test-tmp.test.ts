import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { registerCleanup, sweepStaleDirs, tempDir } from "./test-tmp.ts";

registerCleanup();

test("tempDir names its owner", () => {
  const dir = tempDir("label");
  expect(dir).toContain(`amux-tmp-${process.pid}-label-`);
  expect(existsSync(dir)).toBe(true);
});

test("sweep reclaims a dead pid's directory, keeps a live one's", () => {
  const root = tempDir("sweep-fixture");
  const dead = `${root}/amux-tmp-999999999-old-abc`;
  const live = `${root}/amux-tmp-${process.pid}-mine-abc`;
  mkdirSync(dead);
  mkdirSync(live);
  sweepStaleDirs(root);
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(live)).toBe(true);
  rmSync(live, { recursive: true, force: true });
});

test("a fresh legacy-named directory is left alone", () => {
  const root = tempDir("sweep-fixture");
  const fresh = `${root}/amux-legacy-fixture`;
  mkdirSync(fresh);
  sweepStaleDirs(root);
  expect(existsSync(fresh)).toBe(true);
  rmSync(fresh, { recursive: true, force: true });
});
