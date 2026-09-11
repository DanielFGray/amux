import { BunFileSystem } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import { ConfigProvider, Effect, Layer, Option, Path, PubSub, Stream } from "effect";
import { afterEach, expect } from "bun:test";
import { openDocument, replaceDocument } from "../../amux/src/document-client.ts";
import { startDaemon, type SessionDaemonService } from "../../amux/src/daemon.ts";
import { SessionStore } from "../../amux/src/session.ts";
import { registerCleanup, tempDir } from "../../amux/src/test-tmp.ts";
import { testEffect } from "../../amux/src/test-effect.ts";
import { DocumentError, type DocumentSnapshot, makeDocumentService } from "./document.ts";

const tests = testEffect(BunFileSystem.layer);

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

const snapshot = (uri: string, text: string): DocumentSnapshot => ({
  uri,
  language: "typescript",
  text,
  cursor: { line: 0, character: 0 },
});

const workspace = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "amux-lsp-document-" });
  const file = `${root}/document.ts`;
  yield* fs.writeFileString(file, "export const disk = true;\n");
  return { file, uri: `file://${file}` };
});

tests.live(
  "reads an unopened document from disk",
  Effect.gen(function* () {
    const document = yield* makeDocumentService();
    const { uri } = yield* workspace();
    const loaded = yield* document.read({ uri, language: "typescript" });
    expect(loaded).toEqual(snapshot(uri, "export const disk = true;\n"));
  }),
);

tests.live(
  "reports invalid URIs and missing fallback files as typed errors",
  Effect.gen(function* () {
    const document = yield* makeDocumentService();
    const invalid = yield* document
      .read({ uri: "https://example.com/document.ts", language: "typescript" })
      .pipe(Effect.flip);
    const missing = yield* document
      .read({ uri: "file:///definitely-not-an-amux-document.ts", language: "typescript" })
      .pipe(Effect.flip);
    expect(invalid).toBeInstanceOf(DocumentError);
    expect(missing).toBeInstanceOf(DocumentError);
  }),
);

tests.live(
  "prefers a registered live buffer and restores disk when it withdraws",
  Effect.gen(function* () {
    const document = yield* makeDocumentService();
    const { uri } = yield* workspace();
    const live = snapshot(uri, "export const live = true;\n");
    const release = yield* document.register({
      uri,
      snapshot: Effect.succeed(live),
      changes: Stream.empty,
    });

    expect(yield* document.read({ uri, language: "typescript" })).toEqual(live);
    release();
    expect(yield* document.read({ uri, language: "typescript" })).toEqual(
      snapshot(uri, "export const disk = true;\n"),
    );
  }),
);

tests.live(
  "streams live document changes without sharing them across URIs",
  Effect.gen(function* () {
    const document = yield* makeDocumentService();
    const { uri } = yield* workspace();
    const changes = yield* PubSub.sliding<DocumentSnapshot>({ capacity: 4, replay: 1 });
    yield* document.register({
      uri,
      snapshot: Effect.succeed(snapshot(uri, "export const live = true;\n")),
      changes: Stream.fromPubSub(changes),
    });
    const changed = snapshot(uri, "export const changed = true;\n");
    yield* PubSub.publish(changes, changed);

    expect(Option.getOrUndefined(yield* document.changes(uri).pipe(Stream.runHead))).toEqual(
      changed,
    );
    expect(
      Option.getOrUndefined(
        yield* document.changes("file:///unregistered.ts").pipe(Stream.runHead),
      ),
    ).toEqual(undefined);
  }),
);

tests.live(
  "rejects duplicate providers and scope withdrawal restores disk fallback",
  Effect.gen(function* () {
    const document = yield* makeDocumentService();
    const { uri } = yield* workspace();
    const live = snapshot(uri, "export const scoped = true;\n");
    yield* Effect.gen(function* () {
      const release = yield* document.register({
        uri,
        snapshot: Effect.succeed(live),
        changes: Stream.empty,
      });
      yield* Effect.addFinalizer(() => Effect.sync(release));
      const duplicate = yield* document
        .register({ uri, snapshot: Effect.succeed(live), changes: Stream.empty })
        .pipe(Effect.flip);
      expect(duplicate).toBeInstanceOf(DocumentError);
      expect(yield* document.read({ uri, language: "typescript" })).toEqual(live);
    }).pipe(Effect.scoped);
    expect(yield* document.read({ uri, language: "typescript" })).toEqual(
      snapshot(uri, "export const disk = true;\n"),
    );
  }),
);

testEffect("with session prefers an open OpenDocumentStore buffer over disk", () =>
  Effect.gen(function* () {
    const home = tempDir("lsp-doc-store");
    const env = { HOME: home, XDG_STATE_HOME: join(home, "state") };
    const id = "lsp-doc-store";
    const daemon = yield* Effect.scoped(startDaemon(id)).pipe(
      Effect.provide(
        SessionStore.layer.pipe(Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer))),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    );
    daemons.push(daemon);

    const path = join(home, "note.ts");
    const uri = `file://${path}`;
    yield* Effect.promise(() => Bun.write(path, "export const disk = true;\n"));
    const provide = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
      );

    yield* provide(openDocument(id, path));
    yield* provide(replaceDocument(id, path, "export const store = true;\n", 1));

    const document = yield* makeDocumentService({ session: id }).pipe(
      Effect.provide(BunFileSystem.layer),
    );
    const loaded = yield* provide(document.read({ uri, language: "typescript" }));
    expect(loaded).toEqual(snapshot(uri, "export const store = true;\n"));
    expect(yield* Effect.promise(() => Bun.file(path).text())).toBe("export const disk = true;\n");
  }),
);
