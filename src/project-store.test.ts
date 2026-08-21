import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  layer,
  projectDirectory,
  projectSlug,
  Service,
  type Interface,
  type ProjectStoreError,
} from "./project-store.ts";
import type { PermissionRule } from "./permission.ts";

const directories: string[] = [];
const previousStateHome = process.env.XDG_STATE_HOME;

afterEach(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  await Effect.runPromise(
    Effect.forEach(directories.splice(0), (path) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.remove(path, { recursive: true })),
        Effect.ignore,
      ),
    ).pipe(Effect.provide(BunFileSystem.layer)),
  );
});

/** A temporary state root, so a test never touches the developer's own projects. */
const isolate = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectory({ directory: tmpdir(), prefix: "amux-project-" });
    directories.push(directory);
    process.env.XDG_STATE_HOME = directory;
  }).pipe(Effect.provide(BunFileSystem.layer), Effect.orDie, Effect.runPromise);

/** Open the store for one project, run one thing against it, and close it. */
const run = <A>(root: string, body: (store: Interface) => Effect.Effect<A, ProjectStoreError>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Service, body).pipe(
        Effect.provide(layer(root).pipe(Layer.provide(BunFileSystem.layer))),
        Effect.orDie,
      ),
    ),
  );

test("a project's slug is stable for a root and distinct between roots", () => {
  expect(projectSlug("/home/dan/build/amux")).toBe(projectSlug("/home/dan/build/amux/"));
  expect(projectSlug("/home/dan/build/amux")).not.toBe(projectSlug("/home/other/amux"));
  expect(projectSlug("/home/dan/build/amux")).toStartWith("amux-");
});

test("a fresh database migrates, records its own root, and starts with no rules", async () => {
  await isolate();
  expect(await run("/tmp/project-one", (store) => store.rules)).toEqual([]);

  // Read back with a plain handle: the root is what lets a scan of the projects
  // directory rebuild an index, so it has to be in the file, not in the module.
  const directory = await Effect.runPromise(projectDirectory("/tmp/project-one"));
  const database = new Database(join(directory, "amux.db"));
  expect(database.query<{ root: string }, []>("SELECT root FROM project").get()?.root).toBe(
    "/tmp/project-one",
  );
  expect(
    database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
  ).toBe(3);
  database.close();
});

test("rules survive reopening, in the order they were approved", async () => {
  await isolate();
  const first: PermissionRule = { action: "bash", resource: "git status *", effect: "allow" };
  const second: PermissionRule = { action: "write", resource: "**", effect: "allow" };
  await run("/tmp/project-two", (store) => store.addRules([first]));
  await run("/tmp/project-two", (store) => store.addRules([second]));
  expect(await run("/tmp/project-two", (store) => store.rules)).toEqual([first, second]);
});

test("re-deciding an action and resource moves the rule instead of duplicating it", async () => {
  await isolate();
  await run("/tmp/project-three", (store) =>
    store.addRules([{ action: "bash", resource: "rm *", effect: "deny" }]),
  );
  await run("/tmp/project-three", (store) =>
    store.addRules([{ action: "bash", resource: "rm *", effect: "allow" }]),
  );
  expect(await run("/tmp/project-three", (store) => store.rules)).toEqual([
    { action: "bash", resource: "rm *", effect: "allow" },
  ]);
});

test("an approval in one project is invisible in another", async () => {
  await isolate();
  await run("/tmp/project-here", (store) =>
    store.addRules([{ action: "write", resource: "**", effect: "allow" }]),
  );
  expect(await run("/tmp/project-there", (store) => store.rules)).toEqual([]);
});

test("two open handles on one project both land their writes", async () => {
  await isolate();
  const store = (root: string) => layer(root).pipe(Layer.provide(BunFileSystem.layer));
  const rules = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const one = yield* Service;
        yield* Effect.scoped(
          Effect.flatMap(Service, (two) =>
            Effect.all(
              [
                one.addRules([{ action: "bash", resource: "ls *", effect: "allow" }]),
                two.addRules([{ action: "bash", resource: "cat *", effect: "allow" }]),
              ],
              { concurrency: "unbounded" },
            ),
          ).pipe(Effect.provide(store("/tmp/project-shared"))),
        );
        return yield* one.rules;
      }).pipe(Effect.provide(store("/tmp/project-shared")), Effect.orDie),
    ),
  );
  expect(rules.map((rule) => rule.resource).sort()).toEqual(["cat *", "ls *"]);
});

test("a conversation survives reopening and is isolated by daemon session", async () => {
  await isolate();
  await run("/tmp/project-chat", (store) => store.saveConversation("agent-a", '{"messages":[]}'));
  expect(await run("/tmp/project-chat", (store) => store.conversation("agent-a"))).toBe(
    '{"messages":[]}',
  );
  expect(await run("/tmp/project-chat", (store) => store.conversation("agent-b"))).toBeUndefined();
});

test("prompt admission survives reopening and caller ids are idempotent", async () => {
  await isolate();
  const first = await run("/tmp/project-inbox", (store) =>
    store.admitPrompt("agent-a", "inspect", "queue", true, "request-1"),
  );
  expect(
    await run("/tmp/project-inbox", (store) =>
      store.admitPrompt("agent-a", "inspect", "queue", true, "request-1"),
    ),
  ).toEqual(first);
  expect(await run("/tmp/project-inbox", (store) => store.pendingPrompts("agent-a"))).toEqual([
    first,
  ]);
  await expect(
    run("/tmp/project-inbox", (store) =>
      store.admitPrompt("agent-a", "different", "queue", true, "request-1"),
    ),
  ).rejects.toThrow("already admitted with different contents");
  await expect(
    run("/tmp/project-inbox", (store) =>
      store.admitPrompt("agent-a", "inspect", "steer", true, "request-1"),
    ),
  ).rejects.toThrow("already admitted with different contents");
  await run("/tmp/project-inbox", (store) => store.promotePrompt(first.id));
  expect(await run("/tmp/project-inbox", (store) => store.pendingPrompts("agent-a"))).toEqual([]);
});

test("admit without scheduling remains pending without resume", async () => {
  await isolate();
  const prompt = await run("/tmp/project-no-resume", (store) =>
    store.admitPrompt("agent-a", "later", "queue", false, "request-2"),
  );
  expect(prompt.resume).toBe(false);
  expect(await run("/tmp/project-no-resume", (store) => store.pendingPrompts("agent-a"))).toEqual([
    prompt,
  ]);
});
