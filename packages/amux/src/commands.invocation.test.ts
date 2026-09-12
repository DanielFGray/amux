import { expect, test } from "bun:test";
import { Context, Effect, Option } from "effect";
import {
  CurrentInvocation,
  command,
  commandInvocation,
  makeCommands,
  type CommandInvocation,
} from "./commands.ts";
import { NO_REALM, Realm, paneRealm, realmOf } from "./realm.ts";

/**
 * Commands.run takes an invocation record and is the one place that provides
 * Realm. Key, socket, CLI, and agent each build that record; a realm-reading
 * command sees the same pane binding regardless of which source delivered it.
 */

test("each invocation source reaches Commands.run with the right record", () => {
  const seen: CommandInvocation[] = [];
  const commands = makeCommands({
    "pane.zoom": () =>
      Effect.gen(function* () {
        seen.push(yield* CurrentInvocation);
      }),
  });

  for (const source of ["key", "socket", "cli", "agent"] as const) {
    Effect.runSync(commands.run(command("pane.zoom"), commandInvocation(source, "s1:p1")));
  }

  expect(seen).toEqual([
    { source: "key", pane: "s1:p1" },
    { source: "socket", pane: "s1:p1" },
    { source: "cli", pane: "s1:p1" },
    { source: "agent", pane: "s1:p1" },
  ]);
});

test("a realm-reading command sees the same pane binding over socket as over a key", () => {
  class Thing extends Context.Service<Thing, { readonly of: string }>()("test/Thing") {}
  const paneId = "s1:p3";
  const binding = realmOf(paneRealm(paneId), Context.make(Thing, { of: "pane-three" }));
  const seen: Array<string | undefined> = [];

  const commands = makeCommands(
    {
      "pane.zoom": () =>
        Effect.gen(function* () {
          const realm = yield* Realm;
          seen.push(Option.getOrUndefined(realm.get(Thing))?.of);
        }),
    },
    { realmForPane: (id) => (id === paneId ? binding : NO_REALM) },
  );

  Effect.runSync(commands.run(command("pane.zoom"), commandInvocation("key", paneId)));
  Effect.runSync(commands.run(command("pane.zoom"), commandInvocation("socket", paneId)));
  Effect.runSync(commands.run(command("pane.zoom"), commandInvocation("cli", paneId)));
  Effect.runSync(commands.run(command("pane.zoom"), commandInvocation("agent", paneId)));
  // No pane → NO_REALM.
  Effect.runSync(commands.run(command("pane.zoom"), commandInvocation("socket")));

  expect(seen).toEqual(["pane-three", "pane-three", "pane-three", "pane-three", undefined]);
});

test("withRealm is the same provider Commands.run uses", () => {
  class Thing extends Context.Service<Thing, { readonly of: string }>()("test/Thing") {}
  const paneId = "%1";
  const realmForPane = (id: string) =>
    id === paneId ? realmOf(paneRealm(id), Context.make(Thing, { of: "left" })) : NO_REALM;

  const commands = makeCommands(
    {
      "pane.zoom": () =>
        Effect.gen(function* () {
          return Option.getOrUndefined((yield* Realm).get(Thing))?.of;
        }),
    },
    { realmForPane },
  );

  const fromRun = Effect.runSync(
    commands.run(command("pane.zoom"), commandInvocation("key", paneId)),
  );
  const fromWithRealm = Effect.runSync(
    commands.withRealm(
      commandInvocation("key", paneId),
      Effect.gen(function* () {
        return Option.getOrUndefined((yield* Realm).get(Thing))?.of;
      }),
    ),
  );

  expect(fromRun).toBe("left");
  expect(fromWithRealm).toBe("left");
});
