import { expect, test } from "bun:test";
import { BindingsTag, ContextsTag } from "./api.ts";

// A plugin outside this repo can only see names exported from api.ts (the
// `@danielfgray/amux` specifier). A registry wired into app.tsx but left out
// here is a door a plugin cannot open — this guards the contexts registry
// against the same gap.
test("the contexts registry is reachable through the public plugin API", () => {
  expect(ContextsTag).toBeDefined();
  expect(ContextsTag.key).toBe("amux/Contexts");
  expect(BindingsTag.key).toBe("amux/Bindings");
});
