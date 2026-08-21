import { expect, test } from "bun:test";
import { formatText } from "./format.ts";

test("formatText expands values and nested conditionals", () => {
  expect(
    formatText("#{?active,* ,}#{pane_current_command}#{?pane_title, · #{pane_title},}", {
      active: true,
      pane_current_command: "bun",
      pane_title: "tests",
    }),
  ).toBe("* bun · tests");
});

test("formatText treats absent values as empty and supports modifiers", () => {
  expect(
    formatText("#{b:path/to/file} #{=4:name} #{q:value}", {
      "path/to/file": "path/to/file",
      name: "name",
      value: "value",
    }),
  ).toBe("file name 'value'");
  expect(formatText("#{?missing,yes,no}", {})).toBe("no");
});

test("formatText leaves incomplete expressions literal", () => {
  expect(formatText("before #{unknown", {})).toBe("before #{unknown");
});
