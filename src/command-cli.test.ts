import { test, expect } from "bun:test";
import {
  commandGroups,
  parseArgs,
  fieldNames,
  generateGroupHelp,
  generateHelp,
} from "./command-cli.ts";
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

test("parseArgs exposes an optional cwd override on pane.split", () => {
  expect(parseArgs("pane.split", ["row", "--cwd=/work/tree"]).parsed).toEqual({
    axis: "row",
    cwd: "/work/tree",
  });
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
    parseArgs("notify", ["--title", "Build", "--body", "Finished", "--session", "work"]),
  ).toEqual({
    parsed: { title: "Build", body: "Finished", session: "work" },
    errors: [],
  });
});

test("parseArgs accepts separated values for every flag kind", () => {
  expect(parseArgs("window.select", ["--number", "3"]).parsed).toEqual({ number: 3 });
  expect(
    parseArgs("agent.prompt", ["s1", "do x", "--until", "working", "--timeout", "5000"]).parsed,
  ).toEqual({ target: "s1", text: "do x", until: "working", timeout: 5000 });
  expect(
    parseArgs("pane.resize-divider", ["--path", "[1,0]", "--index", "0", "--delta", "-1"]).parsed,
  ).toEqual({ path: [1, 0], index: 0, delta: -1 });
});

test("parseArgs accepts a separated boolean value only when it is a boolean", () => {
  expect(parseArgs("agent.prompt", ["s1", "do x", "--wait", "false"]).parsed).toEqual({
    target: "s1",
    text: "do x",
    wait: false,
  });
  expect(parseArgs("agent.prompt", ["s1", "do x", "--wait", "true"]).parsed).toEqual({
    target: "s1",
    text: "do x",
    wait: true,
  });
  // A non-boolean token after a boolean flag stays a positional, so a bare
  // flag never swallows the argument that follows it.
  expect(parseArgs("pane.close", ["--current", "--pane", "s1:p3"]).parsed).toEqual({
    current: true,
    pane: "s1:p3",
  });
  expect(parseArgs("pane.close", ["--current", "true"]).parsed).toEqual({ current: true });
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

test("group help derives command syntax from schemas", () => {
  expect(commandGroups()).toContain("agents");
  expect(generateGroupHelp("agents")).toContain(
    "agent.prompt <target> <text> [--wait=<wait>] [--until=<idle|working|blocked|failed|done>] [--timeout=<timeout>]",
  );
  expect(generateGroupHelp("panes")).toContain("pane.split <row|column> [--cwd=<cwd>]");
  expect(generateGroupHelp("missing")).toBeUndefined();
});

test("pane targets are schema fields the CLI parses", () => {
  expect(parseArgs("pane.send-keys", ["--keys", "ls", "--pane", "s1:p3"]).parsed).toEqual({
    keys: "ls",
    pane: "s1:p3",
  });
  expect(parseArgs("pane.close", ["--current"]).parsed).toEqual({ current: true });
  expect(parseArgs("pane.capture", ["--pane", "s1:p3"]).parsed).toEqual({ pane: "s1:p3" });
  // --no-focus is a batch-level context flag, not a command field, so the
  // schema parser refuses it: the CLI strips it before parsing.
  expect(parseArgs("pane.close", ["--no-focus"]).parsed).toBeNull();
});

test("the read surface is exposed to agents with derived fields", () => {
  const panes = fieldNames("pane.list");
  expect(panes.map((f) => f.name)).toEqual([]);
  expect(fieldNames("pane.current").map((f) => f.name)).toEqual(["pane", "current"]);
  expect(fieldNames("pane.layout").map((f) => f.name)).toEqual(["pane", "current"]);
  expect(fieldNames("agent.get").map((f) => f.name)).toEqual(["target"]);
  expect(generateGroupHelp("panes")).toContain("pane.current");
  expect(generateGroupHelp("panes")).toContain("pane.layout");
  expect(generateGroupHelp("panes")).toContain("pane.list");
  expect(generateGroupHelp("spaces")).toContain("space.list");
  expect(generateGroupHelp("windows")).toContain("window.list");
  expect(generateGroupHelp("agents")).toContain("agent.list");
  expect(generateGroupHelp("agents")).toContain("agent.get");
});
