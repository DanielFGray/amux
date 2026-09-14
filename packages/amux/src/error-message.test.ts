import { expect, test } from "bun:test";
import { errorMessage } from "./error-message.ts";

test("an Error whose message is not a string still yields a string", () => {
  const error = new Error("placeholder");
  Object.defineProperty(error, "message", { value: { code: 1 } });
  expect(typeof errorMessage(error)).toBe("string");
});
