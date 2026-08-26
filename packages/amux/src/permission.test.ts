import { expect, test } from "bun:test";
import {
  DEFAULT_RULES,
  evaluate,
  evaluateAll,
  matchWildcard,
  type PermissionRule,
} from "./permission.ts";

test("a pattern matches the whole string, not a prefix of it", () => {
  expect(matchWildcard("git status", "git status")).toBe(true);
  expect(matchWildcard("sudo git status", "git status")).toBe(false);
  expect(matchWildcard("git status --porcelain", "git status *")).toBe(true);
  expect(matchWildcard("src/main.tsx", "src/*")).toBe(true);
  expect(matchWildcard("src/ui/theme.ts", "**")).toBe(true);
});

test("a trailing wildcard covers the bare command, so one decision is one rule", () => {
  expect(matchWildcard("git status", "git status *")).toBe(true);
});

test("regex metacharacters in a rule are literal", () => {
  expect(matchWildcard("a.txt", "a.txt")).toBe(true);
  expect(matchWildcard("axtxt", "a.txt")).toBe(false);
});

test("the last matching rule decides", () => {
  const rules: PermissionRule[] = [
    { action: "*", resource: "*", effect: "ask" },
    { action: "bash", resource: "git *", effect: "allow" },
  ];
  expect(evaluate("bash", "git status", rules)).toBe("allow");
  expect(evaluate("bash", "curl example.com", rules)).toBe("ask");
});

test("a deny holds wherever it sits, so an approval cannot outrank a refusal", () => {
  const rules: PermissionRule[] = [
    { action: "bash", resource: "rm *", effect: "deny" },
    { action: "bash", resource: "*", effect: "allow" },
  ];
  expect(evaluate("bash", "rm -rf /", rules)).toBe("deny");
  expect(evaluate("bash", "ls", rules)).toBe("allow");
});

test("an action nobody has a rule for is asked about", () => {
  expect(evaluate("bash", "ls", [])).toBe("ask");
});

test("by default reading is allowed and everything else asks", () => {
  expect(evaluate("read", "src/main.tsx", DEFAULT_RULES)).toBe("allow");
  expect(evaluate("write", "src/main.tsx", DEFAULT_RULES)).toBe("ask");
  expect(evaluate("bash", "ls", DEFAULT_RULES)).toBe("ask");
  // A tool added later inherits `ask` without anyone amending the defaults.
  expect(evaluate("webfetch", "https://example.com", DEFAULT_RULES)).toBe("ask");
});

test("one unapproved resource blocks the whole call", () => {
  const rules: PermissionRule[] = [{ action: "bash", resource: "ls *", effect: "allow" }];
  expect(evaluateAll("bash", ["ls -la"], rules)).toBe("allow");
  expect(evaluateAll("bash", ["ls -la", "rm -rf /"], rules)).toBe("ask");
});

test("one denied resource denies the whole call", () => {
  const rules: PermissionRule[] = [
    { action: "bash", resource: "*", effect: "allow" },
    { action: "bash", resource: "rm *", effect: "deny" },
  ];
  expect(evaluateAll("bash", ["ls -la", "rm -rf /"], rules)).toBe("deny");
});

test("an action with no resources is asked about rather than waved through", () => {
  expect(evaluateAll("bash", [], [{ action: "*", resource: "*", effect: "allow" }])).toBe("ask");
});
