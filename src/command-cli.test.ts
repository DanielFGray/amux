import { test, expect } from "bun:test";
import { parseArgs, fieldNames, generateHelp } from "./command-cli.ts";
import type { CommandTag } from "./commands.ts";

test("parseArgs handles commands with no arguments", () => {
  expect(parseArgs("pane.zoom", [])).toEqual({ parsed: {}, errors: [] });
  expect(parseArgs("pane.zoom", ["extra"]).parsed).toBeNull();
});

test("parseArgs handles required positional arguments", () => {
  const result = parseArgs("pane.split", ["row"]);
  expect(result.parsed).toEqual({ axis: "row" });
  expect(result.errors).toEqual([]);
});

test("parseArgs handles optional arguments via flags", () => {
  const result = parseArgs("buffer.set", ["my-data", "--name=buf1"]);
  expect(result.parsed).toEqual({ data: "my-data", name: "buf1" });
  expect(result.errors).toEqual([]);
});

test("parseArgs handles int arguments", () => {
  const result = parseArgs("window.select", ["3"]);
  expect(result.parsed).toEqual({ number: 3 });
  expect(result.errors).toEqual([]);
});

test("parseArgs rejects bad int values", () => {
  const result = parseArgs("window.select", ["not-a-number"]);
  expect(result.parsed).toBeNull();
  expect(result.errors.length).toBeGreaterThan(0);
});

test("parseArgs reports missing required args", () => {
  const result = parseArgs("pane.split", []);
  expect(result.parsed).toBeNull();
  expect(result.errors.some((e) => e.includes("axis"))).toBe(true);
});

test("parseArgs reports unknown flags", () => {
  const result = parseArgs("pane.next", ["--nonexistent=1"]);
  expect(result.parsed).toBeNull();
  expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
});

test("parseArgs handles optional command args with all flags", () => {
  const result = parseArgs("space.new", [
    "--name=myname",
    "--dir=/tmp",
    "--branch=feat",
    "--base=main",
  ]);
  expect(result.parsed).toEqual({
    name: "myname",
    dir: "/tmp",
    branch: "feat",
    base: "main",
  });
  expect(result.errors).toEqual([]);
});

test("parseArgs accepts separated notify flags", () => {
  expect(
    parseArgs("notify", [
      "--title",
      "Build",
      "--body",
      "Finished",
      "--session",
      "work",
    ]),
  ).toEqual({
    parsed: { title: "Build", body: "Finished", session: "work" },
    errors: [],
  });
});

test("fieldNames returns all fields for a command", () => {
  const fields = fieldNames("window.rename");
  expect(fields.map((f) => f.name)).toContain("space");
  expect(fields.map((f) => f.name)).toContain("window");
  expect(fields.map((f) => f.name)).toContain("name");
});

test("generateHelp is non-empty", () => {
  const help = generateHelp();
  expect(help.length).toBeGreaterThan(0);
  expect(help).toContain("pane.split");
  expect(help).toContain("buffer.set");
  expect(help).toContain("daemon");
  expect(help).toContain("\\;");
});
