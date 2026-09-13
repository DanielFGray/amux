import { expect, test } from "bun:test";
import { Schema as S } from "effect";
import {
  LayoutRuleSchema,
  layoutRuleMatches,
  resolveTilingAlgorithm,
  type LayoutRule,
} from "./layout-rules.ts";
import { defaultTilingAlgorithm, defaultTilingMethods } from "./tiling-algorithm-default.ts";
import { tilingAlgorithmFromMethods } from "./tiling-algorithm.ts";
import type { TilingAlgorithm } from "./tiling-algorithm.ts";

const algo = (id: string): TilingAlgorithm =>
  tilingAlgorithmFromMethods({ ...defaultTilingMethods, id });

const alpha = algo("alpha");
const beta = algo("beta");
const registered = [alpha, beta, defaultTilingAlgorithm] as const;

test("rules are checked in order; the first matching registered rule wins", () => {
  const rules: LayoutRule[] = [
    { algorithm: "beta", when: { minCols: 100 } },
    { algorithm: "alpha", when: { maxCols: 80 } },
    { algorithm: "beta", when: {} },
  ];
  expect(resolveTilingAlgorithm(rules, "default", registered, { cols: 60, rows: 24 })).toBe(alpha);
  expect(resolveTilingAlgorithm(rules, "default", registered, { cols: 120, rows: 24 })).toBe(beta);
});

test("minCols includes the bound and excludes below it", () => {
  const when = { minCols: 80 };
  expect(layoutRuleMatches(when, { cols: 80, rows: 24 })).toBe(true);
  expect(layoutRuleMatches(when, { cols: 79, rows: 24 })).toBe(false);
});

test("maxCols includes the bound and excludes above it", () => {
  const when = { maxCols: 80 };
  expect(layoutRuleMatches(when, { cols: 80, rows: 24 })).toBe(true);
  expect(layoutRuleMatches(when, { cols: 81, rows: 24 })).toBe(false);
});

test("minRows includes the bound and excludes below it", () => {
  const when = { minRows: 24 };
  expect(layoutRuleMatches(when, { cols: 80, rows: 24 })).toBe(true);
  expect(layoutRuleMatches(when, { cols: 80, rows: 23 })).toBe(false);
});

test("maxRows includes the bound and excludes above it", () => {
  const when = { maxRows: 24 };
  expect(layoutRuleMatches(when, { cols: 80, rows: 24 })).toBe(true);
  expect(layoutRuleMatches(when, { cols: 80, rows: 25 })).toBe(false);
});

test("workspace matches the space name exactly", () => {
  const when = { workspace: "phone" };
  expect(layoutRuleMatches(when, { cols: 80, rows: 24, workspaceName: "phone" })).toBe(true);
  expect(layoutRuleMatches(when, { cols: 80, rows: 24, workspaceName: "desk" })).toBe(false);
  expect(layoutRuleMatches(when, { cols: 80, rows: 24 })).toBe(false);
});

test("a workspace rule applies to every space that shares the name", () => {
  const when = { workspace: "shared" };
  expect(layoutRuleMatches(when, { cols: 80, rows: 24, workspaceName: "shared" })).toBe(true);
});

test("a rule with several bounds needs all of them", () => {
  const when = { minCols: 40, maxCols: 80, minRows: 10, maxRows: 40, workspace: "phone" };
  expect(layoutRuleMatches(when, { cols: 60, rows: 24, workspaceName: "phone" })).toBe(true);
  expect(layoutRuleMatches(when, { cols: 39, rows: 24, workspaceName: "phone" })).toBe(false);
  expect(layoutRuleMatches(when, { cols: 60, rows: 24, workspaceName: "desk" })).toBe(false);
});

test("a rule naming an unregistered algorithm is skipped", () => {
  const rules: LayoutRule[] = [
    { algorithm: "ghost", when: { maxCols: 200 } },
    { algorithm: "alpha", when: { maxCols: 200 } },
  ];
  expect(resolveTilingAlgorithm(rules, "default", registered, { cols: 80, rows: 24 })).toBe(alpha);
});

test("with no matching rule, behaviour.tilingAlgorithm picks a registered algorithm", () => {
  expect(resolveTilingAlgorithm([], "beta", registered, { cols: 80, rows: 24 })).toBe(beta);
});

test("an unregistered behaviour.tilingAlgorithm value gives the default", () => {
  expect(resolveTilingAlgorithm([], "ghost", registered, { cols: 80, rows: 24 })).toBe(
    defaultTilingAlgorithm,
  );
});

test("LayoutRuleSchema round-trips a rule", () => {
  const rule = {
    algorithm: "niri",
    when: { maxCols: 80, workspace: "phone" },
  };
  const decoded = S.decodeSync(LayoutRuleSchema)(rule);
  expect(decoded).toEqual(rule);
  expect(S.encodeSync(LayoutRuleSchema)(decoded)).toEqual(rule);
});
