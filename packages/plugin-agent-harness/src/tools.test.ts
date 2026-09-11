import { expect } from "bun:test";
import { AiError, Tool } from "effect/unstable/ai";
import { BunFileSystem } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import { Effect, Layer, Option, Stream } from "effect";
import { agentToolkit } from "./tools.ts";
import { testEffect } from "@danielfgray/amux/testing";
import { PermissionGateTag, type Assertion, type PermissionGate } from "./permission.ts";

const it = testEffect(Layer.empty);

/** Runs a tool call to its final result. Handlers stream preliminary progress
 *  updates before the authoritative one, which these tests don't need. */
const runHandle = <A, E, R>(effect: Effect.Effect<Stream.Stream<A, E, R>, AiError.AiError>) =>
  effect.pipe(Effect.flatMap(Stream.runLast), Effect.map(Option.getOrThrow));

/** A gate that records what it was asked and answers the same way every time. */
const recording = (answer: (assertion: Assertion) => Effect.Effect<void, string>) => {
  const seen: Assertion[] = [];
  const gate: PermissionGate = {
    assert: (assertion) => {
      seen.push(assertion);
      return answer(assertion);
    },
    resolve: () => Effect.void,
  };
  return { gate, seen };
};

const allowAll = () => recording(() => Effect.void);

const withGate = <A, E, R>(gate: PermissionGate, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(PermissionGateTag, gate));

/** No instructions are ever attached across these tests: an empty store. */
const noInstructions = () => {
  const attached = new Set<string>();
  return {
    attachedInstructions: () => Effect.succeed(attached),
    attachInstructions: (_session: string, paths: readonly string[]) =>
      Effect.sync(() => {
        for (const path of paths) attached.add(path);
      }),
  };
};

it.live("agent toolkit exposes coding tools rather than amux commands", () =>
  Effect.gen(function* () {
    const toolkit = yield* withGate(allowAll().gate, agentToolkit(process.cwd(), {
      session: "agent-1",
      store: noInstructions(),
    }));
    expect(Object.keys(toolkit.tools)).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "find",
      "glob",
      "grep",
      "bash",
    ]);
    for (const tool of Object.values(toolkit.tools)) {
      expect(Tool.getJsonSchema(tool as never)).toMatchObject({ type: "object" });
    }
  }),
);

it.live("read uses workspace-relative paths and line numbers", () =>
  Effect.gen(function* () {
    const toolkit = yield* withGate(allowAll().gate, agentToolkit(process.cwd(), {
      session: "agent-1",
      store: noInstructions(),
    }));
    const output = yield* runHandle(
      toolkit.handle("read", {
        path: "package.json",
        offset: 1,
        limit: 1,
      }),
    );
    expect((output as { result: unknown }).result).toBe("1: {");
  }),
);

it.live("unconstrained read of a large file returns an outline, not the full dump", () =>
  Effect.gen(function* () {
    const fs = yield* Effect.provide(FileSystem.FileSystem, BunFileSystem.layer);
    const workspace = yield* fs.makeTempDirectory({ prefix: "amux-read-outline-" });
    const lines = Array.from({ length: 120 }, (_, i) => `line-${i + 1}`);
    lines[10] = "export function landmark() {}";
    yield* fs.writeFileString(`${workspace}/big.ts`, `${lines.join("\n")}\n`);
    try {
      const toolkit = yield* withGate(allowAll().gate, agentToolkit(workspace, {
        session: "agent-1",
        store: noInstructions(),
      }));
      const outlined = yield* runHandle(toolkit.handle("read", { path: "big.ts" }));
      const text = (outlined as { result: string }).result;
      expect(text).toContain("lines");
      expect(text).toContain("offset=");
      expect(text).toContain("landmark");
      expect(text).not.toContain("line-80");

      const slice = yield* runHandle(
        toolkit.handle("read", { path: "big.ts", offset: 80, limit: 1 }),
      );
      expect((slice as { result: string }).result).toBe("80: line-80");
    } finally {
      yield* fs.remove(workspace, { recursive: true }).pipe(Effect.ignore);
    }
  }),
);

it.live("every tool declares its action, tier, and what it would touch", () =>
  Effect.gen(function* () {
    const { gate, seen } = allowAll();
    const toolkit = yield* withGate(gate, agentToolkit(process.cwd(), {
      session: "agent-1",
      store: noInstructions(),
    }));
    yield* runHandle(toolkit.handle("read", { path: "package.json", offset: 1, limit: 1 }));
    yield* runHandle(toolkit.handle("bash", { command: "true && echo hi" }));
    expect(
      seen.map((assertion) => [assertion.action, assertion.tier, assertion.resources]),
    ).toEqual([
      ["read", "read", ["./package.json"]],
      ["bash", "exec", ["true", "echo hi"]],
    ]);
  }),
);

it.live("bash interceptor blocks cat when read exists, leaves unmatched commands alone", () =>
  Effect.gen(function* () {
    const { gate, seen } = allowAll();
    const toolkit = yield* withGate(gate, agentToolkit(
      process.cwd(),
      { session: "agent-1", store: noInstructions() },
      { bashInterceptor: true },
    ));
    const blocked = yield* runHandle(toolkit.handle("bash", { command: "cat package.json" }));
    expect(blocked).toMatchObject({ isFailure: true });
    expect(String((blocked as { result: string }).result)).toContain("Blocked:");
    expect(String((blocked as { result: string }).result)).toContain("`read`");
    expect(seen).toEqual([]);

    yield* runHandle(toolkit.handle("bash", { command: "true" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.action).toBe("bash");
  }),
);

it.live("bash interceptor can be disabled", () =>
  Effect.gen(function* () {
    const { gate, seen } = allowAll();
    const toolkit = yield* withGate(gate, agentToolkit(
      process.cwd(),
      { session: "agent-1", store: noInstructions() },
      { bashInterceptor: false },
    ));
    yield* runHandle(toolkit.handle("bash", { command: "cat /dev/null" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.resources).toEqual(["cat /dev/null"]);
  }),
);

it.live("a refusal reaches the model as the tool's failure, and nothing runs", () =>
  Effect.gen(function* () {
    const { gate } = recording(() => Effect.fail("Denied by the user: not this time"));
    const toolkit = yield* withGate(gate, agentToolkit(process.cwd(), {
      session: "agent-1",
      store: noInstructions(),
    }));
    const target = `${process.cwd()}/.amux-gate-test-file`;
    // failureMode "return" is what makes a refusal readable by the model: the
    // turn continues carrying the reason instead of dying.
    const result = yield* runHandle(toolkit.handle("write", { path: target, content: "x" }));
    expect(result).toMatchObject({
      isFailure: true,
      result: "Denied by the user: not this time",
    });
    expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false);
  }),
);

it.live("a tool entering a subtree attaches its instructions once", () =>
  Effect.gen(function* () {
    const fs = yield* Effect.provide(FileSystem.FileSystem, BunFileSystem.layer);
    const workspace = yield* fs.makeTempDirectory({ prefix: "amux-nested-" });
    yield* fs.makeDirectory(`${workspace}/lib`, { recursive: true });
    yield* fs.writeFileString(`${workspace}/lib/AGENTS.md`, "lib rules\n");
    yield* fs.writeFileString(`${workspace}/lib/notes.md`, "hi\n");
    try {
      const store = noInstructions();
      const toolkit = yield* withGate(allowAll().gate, agentToolkit(workspace, {
        session: "agent-1",
        store,
      }));
      const first = yield* runHandle(toolkit.handle("read", { path: "lib/notes.md" }));
      expect((first as { result: string }).result).toContain("lib rules");
      expect((first as { result: string }).result).toContain("1: hi");
      const second = yield* runHandle(toolkit.handle("read", { path: "lib/notes.md" }));
      expect((second as { result: string }).result).not.toContain("lib rules");
    } finally {
      yield* fs.remove(workspace, { recursive: true }).pipe(Effect.ignore);
    }
  }),
);

it.live("edit applies unique replacements and refuses ambiguous ones without writing", () =>
  Effect.gen(function* () {
    const fs = yield* Effect.provide(FileSystem.FileSystem, BunFileSystem.layer);
    const workspace = yield* fs.makeTempDirectory({ prefix: "amux-edit-" });
    yield* fs.writeFileString(`${workspace}/note.ts`, "aaa bbb aaa\n");
    try {
      const toolkit = yield* withGate(allowAll().gate, agentToolkit(workspace, {
        session: "offline",
        store: noInstructions(),
      }));
      const ambiguous = yield* runHandle(
        toolkit.handle("edit", {
          path: "note.ts",
          edits: [{ oldText: "aaa", newText: "A" }],
        }),
      );
      expect(ambiguous).toMatchObject({ isFailure: true });
      expect(yield* Effect.promise(() => Bun.file(`${workspace}/note.ts`).text())).toBe(
        "aaa bbb aaa\n",
      );

      const ok = yield* runHandle(
        toolkit.handle("edit", {
          path: "note.ts",
          edits: [{ oldText: "bbb", newText: "BBB" }],
        }),
      );
      expect(ok).toMatchObject({ isFailure: false });
      expect((ok as { result: string }).result).toContain("+aaa BBB aaa");
      expect(yield* Effect.promise(() => Bun.file(`${workspace}/note.ts`).text())).toBe(
        "aaa BBB aaa\n",
      );
    } finally {
      yield* fs.remove(workspace, { recursive: true }).pipe(Effect.ignore);
    }
  }),
);

it.live(
  "apply_patch validates then applies add/update/delete/move; stale patches change nothing",
  () =>
    Effect.gen(function* () {
      const fs = yield* Effect.provide(FileSystem.FileSystem, BunFileSystem.layer);
      const workspace = yield* fs.makeTempDirectory({ prefix: "amux-patch-" });
      yield* fs.writeFileString(`${workspace}/old.ts`, "const y = 1\n");
      yield* fs.writeFileString(`${workspace}/gone.ts`, "bye\n");
      try {
        const toolkit = yield* withGate(allowAll().gate, agentToolkit(workspace, {
          session: "offline",
          store: noInstructions(),
        }));

        const stale = yield* runHandle(
          toolkit.handle("apply_patch", {
            patchText: `*** Begin Patch
*** Update File: old.ts
@@
-const y = 9
+const y = 2
*** End Patch
`,
          }),
        );
        expect(stale).toMatchObject({ isFailure: true });
        expect(yield* Effect.promise(() => Bun.file(`${workspace}/old.ts`).text())).toBe(
          "const y = 1\n",
        );

        const ok = yield* runHandle(
          toolkit.handle("apply_patch", {
            patchText: `*** Begin Patch
*** Add File: new.ts
+export const x = 1
*** Update File: old.ts
*** Move to: moved.ts
@@
-const y = 1
+const y = 2
*** Delete File: gone.ts
*** End Patch
`,
          }),
        );
        expect(ok).toMatchObject({ isFailure: false });
        expect(yield* Effect.promise(() => Bun.file(`${workspace}/new.ts`).text())).toBe(
          "export const x = 1\n",
        );
        expect(yield* Effect.promise(() => Bun.file(`${workspace}/moved.ts`).text())).toBe(
          "const y = 2\n",
        );
        expect(yield* Effect.promise(() => Bun.file(`${workspace}/old.ts`).exists())).toBe(false);
        expect(yield* Effect.promise(() => Bun.file(`${workspace}/gone.ts`).exists())).toBe(false);
      } finally {
        yield* fs.remove(workspace, { recursive: true }).pipe(Effect.ignore);
      }
    }),
);

it.live("edit is gated as an edit action", () =>
  Effect.gen(function* () {
    const { gate, seen } = allowAll();
    const fs = yield* Effect.provide(FileSystem.FileSystem, BunFileSystem.layer);
    const workspace = yield* fs.makeTempDirectory({ prefix: "amux-edit-gate-" });
    yield* fs.writeFileString(`${workspace}/a.ts`, "one\n");
    try {
      const toolkit = yield* withGate(gate, agentToolkit(workspace, {
        session: "offline",
        store: noInstructions(),
      }));
      yield* runHandle(
        toolkit.handle("edit", { path: "a.ts", edits: [{ oldText: "one", newText: "two" }] }),
      );
      expect(seen.map((assertion) => assertion.action)).toEqual(["edit"]);
      expect(seen[0]?.diff).toContain("-one");
      expect(seen[0]?.diff).toContain("+two");
    } finally {
      yield* fs.remove(workspace, { recursive: true }).pipe(Effect.ignore);
    }
  }),
);
