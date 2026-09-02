import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { Cause, ConfigProvider, Effect, Layer, Path } from "effect";
import {
  layer,
  projectDirectory,
  projectSlug,
  Service,
  type Interface,
  type ProjectStoreError,
} from "./project-store.ts";
import type { PermissionRule } from "./permission.ts";
import { testEffect } from "./test-effect.ts";

const directories: string[] = [];
let testConfigProvider = ConfigProvider.fromUnknown({});

afterEach(() => {
  testConfigProvider = ConfigProvider.fromUnknown({});
  return Effect.runPromise(
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
    const directory = yield* fs.makeTempDirectory({ prefix: "amux-project-" });
    directories.push(directory);
    testConfigProvider = ConfigProvider.fromUnknown({ XDG_STATE_HOME: directory });
  }).pipe(Effect.provide(BunFileSystem.layer), Effect.orDie);

/** Open the store for one project, run one thing against it, and close it. */
const run = <A>(root: string, body: (store: Interface) => Effect.Effect<A, ProjectStoreError>) =>
  Effect.scoped(
    Effect.flatMap(Service, body).pipe(
      Effect.provide(
        layer(root).pipe(
          Layer.provide(BunFileSystem.layer),
          Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, testConfigProvider)),
        ),
      ),
      Effect.orDie,
    ),
  );

/** The message a store call refuses with. `run` dies rather than fails, so the
 *  refusal is in the cause, not in a typed error channel. */
const refusal = (effect: Effect.Effect<unknown>) =>
  effect.pipe(
    Effect.as(""),
    Effect.catchCause((cause) => Effect.succeed(String(Cause.squash(cause)))),
  );

test("a project's slug is stable for a root and distinct between roots", () => {
  expect(projectSlug("/home/dan/build/amux")).toBe(projectSlug("/home/dan/build/amux/"));
  expect(projectSlug("/home/dan/build/amux")).not.toBe(projectSlug("/home/other/amux"));
  expect(projectSlug("/home/dan/build/amux")).toStartWith("amux-");
});

testEffect("a fresh database migrates, records its own root, and starts with no rules", () =>
  Effect.gen(function* () {
    yield* isolate();
    expect(yield* run("/tmp/project-one", (store) => store.rules)).toEqual([]);

    // Read back with a plain handle: the root is what lets a scan of the projects
    // directory rebuild an index, so it has to be in the file, not in the module.
    const directory = yield* projectDirectory("/tmp/project-one").pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, testConfigProvider),
    );
    const path = yield* Path.Path;
    const database = new Database(path.join(directory, "amux.db"));
    expect(database.query<{ root: string }, []>("SELECT root FROM project").get()?.root).toBe(
      "/tmp/project-one",
    );
    expect(
      database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(4);
    database.close();
  }).pipe(Effect.provide(Path.layer)),
);

testEffect("rules survive reopening, in the order they were approved", () =>
  Effect.gen(function* () {
    yield* isolate();
    const first: PermissionRule = { action: "bash", resource: "git status *", effect: "allow" };
    const second: PermissionRule = { action: "write", resource: "**", effect: "allow" };
    yield* run("/tmp/project-two", (store) => store.addRules([first]));
    yield* run("/tmp/project-two", (store) => store.addRules([second]));
    expect(yield* run("/tmp/project-two", (store) => store.rules)).toEqual([first, second]);
  }),
);

testEffect("re-deciding an action and resource moves the rule instead of duplicating it", () =>
  Effect.gen(function* () {
    yield* isolate();
    yield* run("/tmp/project-three", (store) =>
      store.addRules([{ action: "bash", resource: "rm *", effect: "deny" }]),
    );
    yield* run("/tmp/project-three", (store) =>
      store.addRules([{ action: "bash", resource: "rm *", effect: "allow" }]),
    );
    expect(yield* run("/tmp/project-three", (store) => store.rules)).toEqual([
      { action: "bash", resource: "rm *", effect: "allow" },
    ]);
  }),
);

testEffect("an approval in one project is invisible in another", () =>
  Effect.gen(function* () {
    yield* isolate();
    yield* run("/tmp/project-here", (store) =>
      store.addRules([{ action: "write", resource: "**", effect: "allow" }]),
    );
    expect(yield* run("/tmp/project-there", (store) => store.rules)).toEqual([]);
  }),
);

testEffect("two open handles on one project both land their writes", () =>
  Effect.gen(function* () {
    yield* isolate();
    const store = (root: string) =>
      layer(root).pipe(
        Layer.provide(BunFileSystem.layer),
        Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, testConfigProvider)),
      );
    const rules = yield* Effect.scoped(
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
    );
    expect(rules.map((rule) => rule.resource).sort()).toEqual(["cat *", "ls *"]);
  }),
);

testEffect("a conversation survives reopening and is isolated by daemon session", () =>
  Effect.gen(function* () {
    yield* isolate();
    yield* run("/tmp/project-chat", (store) =>
      store.saveConversation("agent-a", '{"messages":[]}'),
    );
    expect(yield* run("/tmp/project-chat", (store) => store.conversation("agent-a"))).toBe(
      '{"messages":[]}',
    );
    expect(
      yield* run("/tmp/project-chat", (store) => store.conversation("agent-b")),
    ).toBeUndefined();
  }),
);

testEffect("prompt admission survives reopening and caller ids are idempotent", () =>
  Effect.gen(function* () {
    yield* isolate();
    const first = yield* run("/tmp/project-inbox", (store) =>
      store.admitPrompt("agent-a", "inspect", "queue", true, "request-1"),
    );
    expect(
      yield* run("/tmp/project-inbox", (store) =>
        store.admitPrompt("agent-a", "inspect", "queue", true, "request-1"),
      ),
    ).toEqual(first);
    expect(yield* run("/tmp/project-inbox", (store) => store.pendingPrompts("agent-a"))).toEqual([
      first,
    ]);
    expect(
      yield* refusal(
        run("/tmp/project-inbox", (store) =>
          store.admitPrompt("agent-a", "different", "queue", true, "request-1"),
        ),
      ),
    ).toContain("already admitted with different contents");
    expect(
      yield* refusal(
        run("/tmp/project-inbox", (store) =>
          store.admitPrompt("agent-a", "inspect", "steer", true, "request-1"),
        ),
      ),
    ).toContain("already admitted with different contents");
    yield* run("/tmp/project-inbox", (store) => store.promotePrompt(first.id));
    expect(yield* run("/tmp/project-inbox", (store) => store.pendingPrompts("agent-a"))).toEqual(
      [],
    );
  }),
);

testEffect("admit without scheduling remains pending without resume", () =>
  Effect.gen(function* () {
    yield* isolate();
    const prompt = yield* run("/tmp/project-no-resume", (store) =>
      store.admitPrompt("agent-a", "later", "queue", false, "request-2"),
    );
    expect(prompt.resume).toBe(false);
    expect(
      yield* run("/tmp/project-no-resume", (store) => store.pendingPrompts("agent-a")),
    ).toEqual([prompt]);
  }),
);
