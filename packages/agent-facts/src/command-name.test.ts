import { expect, test } from "bun:test";
import { commandName, executableName } from "./command-name.ts";

test("names a launched command without agent policy", () => {
  expect(commandName(["/usr/bin/nvim"])).toBe("nvim");
  expect(commandName(["-zsh"])).toBe("zsh");
  expect(commandName([])).toBe("shell");
});

test("strips path, extension, and case from an executable token", () => {
  expect(executableName("/usr/bin/Claude.JS")).toBe("claude");
  expect(executableName("codex")).toBe("codex");
});
