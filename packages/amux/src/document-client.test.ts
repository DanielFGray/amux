import { afterEach, expect } from "bun:test";
import { ConfigProvider, Effect, Layer, Path } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import {
  writeDocument,
  openDocument,
  readDocumentSnapshot,
  replaceDocument,
  closeDocument,
} from "./document-client.ts";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { registerCleanup, tempDir } from "./test-tmp.ts";
import { SessionStore } from "./session.ts";
import { testEffect } from "./test-effect.ts";
import { Option } from "effect";

registerCleanup();

const join = (...paths: string[]) =>
  Effect.runSync(
    Effect.map(Path.Path, (path) => path.join(...paths)).pipe(Effect.provide(Path.layer)),
  );
const daemons: SessionDaemonService[] = [];
afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const daemon of daemons.splice(0)) yield* daemon.stop.pipe(Effect.ignore);
    }),
  ),
);

testEffect("writeDocument opens, replaces, and persists through the control plane", () =>
  Effect.gen(function* () {
    const home = tempDir("doc-client");
    const env = { HOME: home, XDG_STATE_HOME: join(home, "state") };
    const id = "doc-client";
    const daemon = yield* Effect.scoped(startDaemon(id)).pipe(
      Effect.provide(
        SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    );
    daemons.push(daemon);

    const path = join(home, "note.ts");
    yield* Effect.promise(() => Bun.write(path, "old\n"));

    yield* openDocument(id, path).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    );
    yield* writeDocument(id, path, "new\n").pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    );

    expect(yield* Effect.promise(() => Bun.file(path).text())).toBe("new\n");
    const snap = yield* readDocumentSnapshot(id, path).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    );
    expect(Option.isSome(snap)).toBe(true);
    if (Option.isSome(snap)) {
      expect(snap.value.text).toBe("new\n");
      expect(snap.value.dirty).toBe(false);
    }
  }),
);

testEffect("replaceDocument updates the store without persisting", () =>
  Effect.gen(function* () {
    const home = tempDir("doc-replace");
    const env = { HOME: home, XDG_STATE_HOME: join(home, "state") };
    const id = "doc-replace";
    const daemon = yield* Effect.scoped(startDaemon(id)).pipe(
      Effect.provide(
        SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    );
    daemons.push(daemon);

    const path = join(home, "scratch.ts");
    yield* Effect.promise(() => Bun.write(path, "disk\n"));
    const provide = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
      );

    yield* provide(openDocument(id, path));
    const meta = yield* provide(replaceDocument(id, path, "memory\n", 1));
    expect(meta.generation).toBe(2);
    expect(meta.dirty).toBe(true);
    expect(yield* Effect.promise(() => Bun.file(path).text())).toBe("disk\n");

    const snap = yield* provide(readDocumentSnapshot(id, path));
    expect(Option.isSome(snap)).toBe(true);
    if (Option.isSome(snap)) {
      expect(snap.value.text).toBe("memory\n");
      expect(snap.value.dirty).toBe(true);
    }
  }),
);

testEffect("closeDocument force-drops an open dirty buffer", () =>
  Effect.gen(function* () {
    const home = tempDir("doc-close");
    const env = { HOME: home, XDG_STATE_HOME: join(home, "state") };
    const id = "doc-close";
    const daemon = yield* Effect.scoped(startDaemon(id)).pipe(
      Effect.provide(
        SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    );
    daemons.push(daemon);

    const path = join(home, "scratch.ts");
    yield* Effect.promise(() => Bun.write(path, "disk\n"));
    const provide = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
      );

    yield* provide(openDocument(id, path));
    yield* provide(replaceDocument(id, path, "dirty\n", 1));
    yield* provide(closeDocument(id, path, true));
    const snap = yield* provide(readDocumentSnapshot(id, path));
    expect(Option.isNone(snap)).toBe(true);
    expect(yield* Effect.promise(() => Bun.file(path).text())).toBe("disk\n");
  }),
);
