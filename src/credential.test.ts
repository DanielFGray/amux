import { expect } from "bun:test";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Redacted } from "effect";
import { Credential } from "./credential.ts";
import { testEffect } from "./test-effect.ts";

async function environment() {
  const home = await mkdtemp(join(tmpdir(), "amux-credential-"));
  return { HOME: home, XDG_STATE_HOME: join(home, "state") };
}

function provide<A>(effect: Effect.Effect<A, any, any>, env: NodeJS.ProcessEnv) {
  return effect.pipe(
    Effect.provide(Credential.Default),
    Effect.provide(BunFileSystem.layer),
    Effect.withConfigProvider(ConfigProvider.fromJson(env)),
  ) as Effect.Effect<A, any, never>;
}

const key = (value: string) => ({
  type: "key" as const,
  key: Redacted.make(value),
});

testEffect("stores multiple credentials and redacts values", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(env.HOME!, { recursive: true, force: true })),
    );
    const first = yield* provide(
      Credential.Service.pipe(
        Effect.flatMap((store) =>
          store.create({
            integrationID: "openai",
            value: key("first"),
            label: "work",
          }),
        ),
      ),
      env,
    );
    const second = yield* provide(
      Credential.Service.pipe(
        Effect.flatMap((store) =>
          store.create({
            integrationID: "openai",
            value: key("second"),
            label: "personal",
          }),
        ),
      ),
      env,
    );
    expect(
      (yield* provide(
        Credential.Service.pipe(Effect.flatMap((store) => store.list("openai"))),
        env,
      )).map((item) => item.id),
    ).toEqual([first.id, second.id]);
    if (first.value.type !== "key") throw new Error("expected key credential");
    expect(`${first.value.key}`).toBe("<redacted>");
    expect(Redacted.value(first.value.key)).toBe("first");
  }),
);

testEffect("skips a corrupt row without hiding valid credentials", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(env.HOME!, { recursive: true, force: true })),
    );
    const directory = join(env.XDG_STATE_HOME!, "amux");
    yield* Effect.promise(() => mkdir(directory, { recursive: true }));
    yield* Effect.promise(() =>
      writeFile(
        join(directory, "auth.json"),
        JSON.stringify([
          {
            id: "good",
            integrationID: "openai",
            label: "good",
            value: { type: "key", key: "secret" },
          },
          {
            id: "bad",
            integrationID: "openai",
            label: 42,
            value: { type: "key", key: "broken" },
          },
        ]),
      ),
    );
    const rows = yield* provide(
      Credential.Service.pipe(Effect.flatMap((store) => store.all())),
      env,
    );
    expect(rows.map((row) => row.id)).toEqual(["good" as Credential.ID]);
  }),
);

testEffect("creates private state and credential files", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(env.HOME!, { recursive: true, force: true })),
    );
    yield* provide(
      Credential.Service.pipe(
        Effect.flatMap((store) => store.create({ integrationID: "openai", value: key("secret") })),
      ),
      env,
    );
    const directory = join(env.XDG_STATE_HOME!, "amux");
    expect((yield* Effect.promise(() => stat(directory))).mode & 0o777).toBe(0o700);
    expect((yield* Effect.promise(() => stat(join(directory, "auth.json")))).mode & 0o777).toBe(
      0o600,
    );
  }),
);

testEffect("repairs permissions before reading existing credentials", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(env.HOME!, { recursive: true, force: true })),
    );
    const directory = join(env.XDG_STATE_HOME!, "amux");
    const file = join(directory, "auth.json");
    yield* Effect.promise(() => mkdir(directory, { recursive: true, mode: 0o777 }));
    yield* Effect.promise(() =>
      writeFile(
        file,
        JSON.stringify([
          {
            id: "one",
            integrationID: "openai",
            label: "x",
            value: { type: "key", key: "secret" },
          },
        ]),
      ),
    );
    yield* Effect.promise(() => chmod(directory, 0o777));
    yield* Effect.promise(() => chmod(file, 0o644));
    yield* provide(Credential.Service.pipe(Effect.flatMap((store) => store.all())), env);
    expect((yield* Effect.promise(() => stat(directory))).mode & 0o777).toBe(0o700);
    expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600);
  }),
);

testEffect("does not overwrite malformed top-level JSON", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(env.HOME!, { recursive: true, force: true })),
    );
    const directory = join(env.XDG_STATE_HOME!, "amux");
    const file = join(directory, "auth.json");
    yield* Effect.promise(() => mkdir(directory, { recursive: true }));
    yield* Effect.promise(() => writeFile(file, "not json"));
    const result = yield* Effect.exit(
      provide(
        Credential.Service.pipe(
          Effect.flatMap((store) =>
            store.create({ integrationID: "openai", value: key("secret") }),
          ),
        ),
        env,
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("not json");
  }),
);

testEffect("updates and removes by credential id", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(env.HOME!, { recursive: true, force: true })),
    );
    const created = yield* provide(
      Credential.Service.pipe(
        Effect.flatMap((store) => store.create({ integrationID: "openai", value: key("secret") })),
      ),
      env,
    );
    yield* provide(
      Credential.Service.pipe(
        Effect.flatMap((store) =>
          store.update(created.id, { label: "updated", value: key("new") }),
        ),
      ),
      env,
    );
    expect(
      (yield* provide(
        Credential.Service.pipe(Effect.flatMap((store) => store.get(created.id))),
        env,
      ))?.label,
    ).toBe("updated");
    yield* provide(
      Credential.Service.pipe(Effect.flatMap((store) => store.remove(created.id))),
      env,
    );
    expect(
      yield* provide(
        Credential.Service.pipe(Effect.flatMap((store) => store.get(created.id))),
        env,
      ),
    ).toBeUndefined();
  }),
);

testEffect("serializes mutations from separate processes without losing writes", () =>
  Effect.gen(function* () {
    const env = yield* Effect.promise(environment);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(env.HOME!, { recursive: true, force: true })),
    );
    const worker = `
    import { FileSystem } from "@effect/platform";
    import { BunFileSystem } from "@effect/platform-bun";
    import { Effect, Redacted } from "effect";
    import { Credential } from ${JSON.stringify(new URL("./credential.ts", import.meta.url).href)};
    const value = { type: "key", key: Redacted.make("secret") };
    const program = Effect.gen(function* () {
      const store = yield* Credential.Service;
      for (let i = 0; i < 8; i++) yield* store.create({ integrationID: "openai", label: process.env.WORKER + i, value });
    }).pipe(Effect.provide(Credential.Default), Effect.provide(BunFileSystem.layer));
    await Effect.runPromise(program);
  `;
    const children = ["a", "b"].map((workerID) =>
      Bun.spawn([process.execPath, "-e", worker], {
        env: { ...process.env, ...env, WORKER: workerID },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = yield* Effect.promise(() =>
      Promise.all(
        children.map(async (child) => ({
          code: await child.exited,
          stderr: await new Response(child.stderr).text(),
        })),
      ),
    );
    expect(results).toEqual([
      { code: 0, stderr: "" },
      { code: 0, stderr: "" },
    ]);
    expect(
      yield* provide(Credential.Service.pipe(Effect.flatMap((store) => store.list("openai"))), env),
    ).toHaveLength(16);
  }),
);
