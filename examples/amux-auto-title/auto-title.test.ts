/** @effect-diagnostics *:skip-file -- process-plugin dogfood tests for plain Bun helpers. */
import { expect, test } from "bun:test";
import { amuxArgv, desiredTitle } from "./auto-title.ts";

test("desiredTitle prefers focused agent name", () => {
  expect(
    desiredTitle(
      { space: "s1", number: 2, name: null, focused: "pane-b" },
      [
        { space: "s1", window: 2, pane: "pane-a", name: "shell" },
        { space: "s1", window: 2, pane: "pane-b", name: "claude" },
      ],
    ),
  ).toBe("2 · claude");
});

test("desiredTitle falls back to cmd basename then shell", () => {
  expect(
    desiredTitle(
      { space: "s1", number: 1, name: null, focused: null },
      [{ space: "s1", window: 1, name: "  ", cmd: ["/usr/bin/nvim"] }],
    ),
  ).toBe("1 · nvim");
  expect(
    desiredTitle({ space: "s1", number: 3, name: null, focused: null }, []),
  ).toBe("3");
});

test("amuxArgv suffixes session after the verb", () => {
  expect(amuxArgv("/opt/amux/cli.ts", "sess", ["window.list"])).toEqual([
    process.execPath,
    "/opt/amux/cli.ts",
    "window.list",
    "--session=sess",
  ]);
  expect(amuxArgv("/usr/bin/amux", "sess", ["agent.list"])).toEqual([
    "/usr/bin/amux",
    "agent.list",
    "--session=sess",
  ]);
});
