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
  createConstraintTable,
  type ConstraintRank,
  type ConstraintRule,
  type ConstraintSource,
} from "./constraint.ts";
import { DEFAULT_RULES, evaluate, type PermissionRule } from "./permission.ts";

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
  expect(combineConstraintRules([], "bash", "ls")).toBe("ask");
});

test("constraint ranks concatenate in fixed order, not registration order", () => {
  const defaults = source("defaults", "defaults", [rule("*", "*", "ask")]);
  const config = source("config", "config", [rule("bash", "rm *", "deny")]);
  const project = source("project", "project", [rule("bash", "*", "allow")]);
  const trio = [defaults, config, project];

  const outcomes = permutations(trio).map((order) => {
    const table = createConstraintTable();
    const disposers = order.map((entry) => table.register(entry));
    const denied = table.decide("bash", "rm -rf /");
    const allowed = table.decide("bash", "ls");
    for (const dispose of disposers) dispose();
    return { denied, allowed, order: order.map((entry) => entry.rank).join(",") };
  });

  expect(outcomes.length).toBe(6);
  for (const outcome of outcomes) {
    expect(outcome.denied).toBe("deny");
    expect(outcome.allowed).toBe("allow");
  }
});

test("withdrawing one constraint source does not disturb the others", () => {
  const table = createConstraintTable();
  const dropDefaults = table.register(
    source("defaults", "defaults", [rule("*", "*", "ask"), rule("read", "*", "allow")]),
  );
  const dropConfig = table.register(
    source("config", "config", [rule("bash", "curl *", "deny")]),
  );
  table.register(source("project", "project", [rule("bash", "*", "allow")]));

  expect(table.decide("bash", "curl example.com")).toBe("deny");
  expect(table.decide("bash", "ls")).toBe("allow");
  expect(table.decide("read", "x")).toBe("allow");

  dropConfig();
  // Config deny gone; project allow remains. Defaults alone would ask for bash.
  expect(table.decide("bash", "curl example.com")).toBe("allow");
  expect(table.decide("bash", "ls")).toBe("allow");
  expect(table.decide("read", "x")).toBe("allow");

  dropDefaults();
  expect(table.decide("read", "x")).toBe("ask"); // no defaults; project has no read rule
  expect(table.decide("bash", "ls")).toBe("allow");
});

test("a second source at the same rank is rejected", () => {
  const table = createConstraintTable();
  table.register(source("a", "config", [rule("*", "*", "ask")]));
  expect(() => table.register(source("b", "config", [rule("*", "*", "deny")]))).toThrow(
    /constraint rank 'config' is already registered by 'a'/,
  );
});

test("permission semantics map onto the substrate without migrating permission.ts", () => {
  // Same three fixed sources permission.ts documents: defaults, config, project.
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
  const table = createConstraintTable();
  // Deliberately register out of rank order — project before config.
  table.register(source("project", "project", project));
  table.register(source("defaults", "defaults", defaults));
  table.register(source("config", "config", config));

  const cases: Array<[string, string]> = [
    ["read", "src/main.tsx"],
    ["bash", "ls"],
    ["bash", "rm -rf /"],
    ["write", "src/main.tsx"],
    ["write", "src/generated/out.ts"],
    ["webfetch", "https://example.com"],
  ];
  for (const [action, resource] of cases) {
    expect(table.decide(action, resource)).toBe(evaluate(action, resource, flat));
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
