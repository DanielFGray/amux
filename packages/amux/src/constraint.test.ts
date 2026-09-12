/**
 * Move 4 constraint substrate — commutativity is the deliverable.
 * permission.ts stays untouched; the mapping tests reconstruct its semantics here.
 */
/** @effect-diagnostics *:skip-file -- plain-async by design: OpenTUI test renderer + key mock, same seam as bindings.test.ts. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createTestRenderer } from "@opentui/core/testing";
import { createBindings } from "./bindings.ts";
import {
  combineConstraintRules,
  combineConstraintRulesAll,
  createConstraintTable,
  DEFAULT_CONSTRAINT_SOURCE,
  type ConstraintRank,
  type ConstraintRule,
  type ConstraintSource,
} from "./constraint.ts";
import { DEFAULT_RULES, evaluate, evaluateAll, type PermissionRule } from "./permission.ts";

const rule = (
  action: string,
  resource: string,
  effect: ConstraintRule["effect"],
): ConstraintRule => ({ action, resource, effect });

const source = (
  id: string,
  rank: ConstraintRank,
  rules: readonly ConstraintRule[],
): ConstraintSource => ({
  id,
  rank,
  rules: () => rules,
});

/** Every permutation of registering three ranked sources. */
const permutations = <A>(items: readonly A[]): A[][] => {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
};

test("combineConstraintRules: deny wins wherever it sits; else last match", () => {
  expect(
    combineConstraintRules(
      [
        {
          rank: "defaults",
          rules: [rule("bash", "rm *", "deny"), rule("bash", "*", "allow")],
        },
      ],
      "bash",
      "rm -rf /",
    ),
  ).toBe("deny");
  expect(
    combineConstraintRules(
      [{ rank: "defaults", rules: [rule("*", "*", "ask"), rule("bash", "git *", "allow")] }],
      "bash",
      "git status",
    ),
  ).toBe("allow");
  // Monoid identity: empty match list → ask. The production allow default is
  // table data (DEFAULT_CONSTRAINT_SOURCE), not a combine special case.
  expect(combineConstraintRules([], "bash", "ls")).toBe("ask");
});

test("constraint ranks concatenate in fixed order, not registration order", () => {
  // Factory already owns defaults; permute the three higher ranks.
  const config = source("config", "config", [rule("bash", "rm *", "deny")]);
  const project = source("project", "project", [rule("bash", "*", "allow")]);
  const runtime = source("runtime", "runtime", [rule("bash", "curl *", "ask")]);
  const trio = [config, project, runtime];

  const outcomes = permutations(trio).map((order) => {
    const table = createConstraintTable();
    const disposers = order.map((entry) => table.register(entry));
    const denied = table.decide("bash", "rm -rf /");
    const allowed = table.decide("bash", "ls");
    const asked = table.decide("bash", "curl example.com");
    for (const dispose of disposers) dispose();
    return { denied, allowed, asked, order: order.map((entry) => entry.rank).join(",") };
  });

  expect(outcomes.length).toBe(6);
  for (const outcome of outcomes) {
    expect(outcome.denied).toBe("deny");
    expect(outcome.allowed).toBe("allow");
    expect(outcome.asked).toBe("ask");
  }
});

test("withdrawing one constraint source does not disturb the others", () => {
  const table = createConstraintTable();
  const dropConfig = table.register(
    source("config", "config", [rule("bash", "curl *", "deny")]),
  );
  table.register(source("project", "project", [rule("bash", "*", "allow")]));

  expect(table.decide("bash", "curl example.com")).toBe("deny");
  expect(table.decide("bash", "ls")).toBe("allow");
  expect(table.decide("read", "x")).toBe("allow"); // factory defaults

  dropConfig();
  // Config deny gone; project allow remains. Defaults alone would allow.
  expect(table.decide("bash", "curl example.com")).toBe("allow");
  expect(table.decide("bash", "ls")).toBe("allow");
  expect(table.decide("read", "x")).toBe("allow");
});

test("a second source at the same rank is rejected", () => {
  const table = createConstraintTable();
  table.register(source("a", "config", [rule("*", "*", "ask")]));
  expect(() => table.register(source("b", "config", [rule("*", "*", "deny")]))).toThrow(
    /constraint rank 'config' is already registered by 'a'/,
  );
  expect(() =>
    table.register(source("other", "defaults", [rule("*", "*", "deny")])),
  ).toThrow(/constraint rank 'defaults' is already registered by 'amux.constraints.defaults'/);
});

test("permission semantics map onto the substrate without migrating permission.ts", () => {
  // Same three fixed sources permission.ts documents: defaults, config, project.
  // Exercised via combineConstraintRules so the factory's allow default does not
  // occupy the defaults rank — the mapping is the monoid, not the production seed.
  const defaults: readonly PermissionRule[] = DEFAULT_RULES;
  const config: readonly PermissionRule[] = [
    { action: "bash", resource: "rm *", effect: "deny" },
    { action: "write", resource: "src/*", effect: "ask" },
  ];
  const project: readonly PermissionRule[] = [
    { action: "bash", resource: "*", effect: "allow" },
    { action: "write", resource: "src/generated/*", effect: "allow" },
  ];

  const flat = [...defaults, ...config, ...project];
  const ranked = [
    { rank: "defaults" as const, rules: defaults },
    { rank: "config" as const, rules: config },
    { rank: "project" as const, rules: project },
  ];

  const cases: Array<[string, string]> = [
    ["read", "src/main.tsx"],
    ["bash", "ls"],
    ["bash", "rm -rf /"],
    ["write", "src/main.tsx"],
    ["write", "src/generated/out.ts"],
    ["webfetch", "https://example.com"],
  ];
  for (const [action, resource] of cases) {
    expect(combineConstraintRules(ranked, action, resource)).toBe(
      evaluate(action, resource, flat),
    );
  }
});

test("factory seeds defaults-rank allow; higher ranks outrank it", () => {
  const table = createConstraintTable();
  expect(table.sources()).toEqual([
    { id: DEFAULT_CONSTRAINT_SOURCE.id, rank: "defaults" },
  ]);
  // No user rules → every call allowed.
  expect(table.decide("pane.split", "*")).toBe("allow");
  expect(table.decide("bash", "rm -rf /")).toBe("allow");
  expect(table.decide("webfetch", "https://example.com")).toBe("allow");

  table.register(source("config", "config", [rule("bash", "rm *", "deny")]));
  expect(table.decide("bash", "rm -rf /")).toBe("deny");
  expect(table.decide("bash", "ls")).toBe("allow");

  table.register(source("project", "project", [rule("bash", "curl *", "ask")]));
  expect(table.decide("bash", "curl example.com")).toBe("ask");
  expect(table.decide("bash", "ls")).toBe("allow");

  table.register(source("runtime", "runtime", [rule("pane.split", "*", "deny")]));
  expect(table.decide("pane.split", "*")).toBe("deny");
});

test("bindings.constraints exposes the factory default for inspect", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const bindings = createBindings(t.renderer, [], {
      keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
      onUnhandled: () => true,
    });
    expect(bindings.constraints.sources()).toEqual([
      { id: "amux.constraints.defaults", rank: "defaults" },
    ]);
    expect(bindings.constraints.decide("any.command", "*")).toBe("allow");
  } finally {
    t.renderer.destroy();
  }
});

test("invoke refuses a command when constraints decide deny", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const fired: string[] = [];
    const errors: string[] = [];
    const bindings = createBindings(
      t.renderer,
      [
        {
          name: "t.danger",
          key: "<prefix>x",
          desc: "danger",
          group: "t",
          run: Effect.sync(() => {
            fired.push("ran");
          }),
        },
      ],
      {
        keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
        onUnhandled: () => true,
        onError: (message) => errors.push(message),
      },
    );
    bindings.constraints.register(
      source("runtime", "runtime", [rule("t.danger", "*", "deny")]),
    );

    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("x");
    await Bun.sleep(20);

    expect(fired).toEqual([]);
    expect(errors.some((message) => message.includes("command denied"))).toBe(true);
  } finally {
    t.renderer.destroy();
  }
});

test("combineConstraintRulesAll: resource-scoped rules match declared resources", () => {
  const ranked = [
    {
      rank: "config" as const,
      rules: [
        rule("*", "*", "allow"),
        rule("pane.close", "editor-*", "deny"),
        rule("pane.close", "shell-*", "ask"),
      ],
    },
  ];
  expect(combineConstraintRulesAll(ranked, "pane.close", ["editor-1"])).toBe("deny");
  expect(combineConstraintRulesAll(ranked, "pane.close", ["shell-1"])).toBe("ask");
  expect(combineConstraintRulesAll(ranked, "pane.close", ["term-1"])).toBe("allow");
  expect(combineConstraintRulesAll(ranked, "pane.close", ["shell-1", "editor-2"])).toBe("deny");
  // Same as permission.evaluateAll for each resource.
  for (const resources of [["editor-1"], ["shell-1"], ["term-1"], ["shell-1", "editor-2"]] as const) {
    expect(combineConstraintRulesAll(ranked, "pane.close", resources)).toBe(
      evaluateAll("pane.close", resources, ranked[0]!.rules),
    );
  }
});

test("combineConstraintRulesAll: empty resources match only '*' resource rules", () => {
  const ranked = [
    {
      rank: "config" as const,
      rules: [
        rule("*", "*", "allow"),
        rule("pane.close", "editor-*", "deny"),
        rule("pane.zoom", "*", "deny"),
      ],
    },
  ];
  // [] is verb-only — the editor-* deny does not fire.
  expect(combineConstraintRulesAll(ranked, "pane.close", [])).toBe("allow");
  expect(combineConstraintRulesAll(ranked, "pane.zoom", [])).toBe("deny");
  expect(combineConstraintRulesAll(ranked, "pane.close", [])).toBe(
    evaluateAll("pane.close", [], ranked[0]!.rules),
  );
});
