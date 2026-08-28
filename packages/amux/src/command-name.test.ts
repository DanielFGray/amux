import { expect, test } from "bun:test";
import { commandName } from "./command-name.ts";

test("names a launched command without agent policy", () => {
  expect(commandName(["/usr/bin/nvim"])).toBe("nvim");
  expect(commandName(["-zsh"])).toBe("zsh");
  expect(commandName([])).toBe("shell");
});
