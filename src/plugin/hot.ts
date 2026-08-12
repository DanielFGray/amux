import { Effect, Schema as S } from "effect";
import { plugin } from "bun";
import { fileURLToPath } from "node:url";
import type { PluginDefinition } from "./types.ts";

/**
 * A plugin's own source, imported again.
 *
 * Bun keys its module cache on the resolved specifier, so a query string buys a
 * fresh evaluation of the file. That query does not reach the module's own
 * imports, which is what the resolver below is for — and the boundary it stops
 * at is the whole design: a plugin's directory reloads with it, and everything
 * outside that directory (the host API, effect, solid-js) stays the one
 * instance the rest of the client is using. Duplicating a module that holds
 * state is how a hot reload starts lying about what is running.
 */

/** The trailing `?hot=<n>` that marks a module as one generation of a plugin. */
const TOKEN = /\?hot=\d+$/;

/** A plugin's reloadable half: the directory named after its entry file. */
export const pluginRoot = (source: URL): string =>
  `${fileURLToPath(source).replace(/\.[cm]?[jt]sx?$/, "")}/`;

const roots = new Set<string>();
let installed = false;
let generation = 0;

/**
 * Teach Bun to carry a generation across a plugin's own imports.
 *
 * Registration is global and one-time; every call after the first is a no-op,
 * so the loader can simply ask before each import rather than the app having to
 * remember to install it first.
 */
export function installHotLoader(): void {
  if (installed) return;
  installed = true;
  plugin({
    name: "amux-hot",
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        const carried = TOKEN.exec(args.importer);
        if (!carried) return undefined;
        const target = new URL(args.path, `file://${args.importer.replace(TOKEN, "")}`).pathname;
        for (const root of roots) if (target.startsWith(root)) return { path: target + carried[0] };
        return undefined;
      });
      // Bun reads a path a plugin resolved exactly as written, so a `.ts`
      // carrying a generation has to be read with it stripped. `.tsx` is
      // deliberately not matched: @opentui/solid's preload already claims those
      // and already strips the query, and taking a component away from that
      // handler would silently produce a UI that never updates.
      build.onLoad({ filter: /\.[cm]?ts\?hot=\d+$/ }, async (args) => ({
        contents: await Bun.file(args.path.replace(TOKEN, "")).text(),
        loader: "ts",
      }));
    },
  });
}

/** A fresh instance of the plugin whose entry file is `source`. */
export const hotImport = (source: URL): Effect.Effect<PluginDefinition, string> =>
  Effect.suspend(() => {
    installHotLoader();
    roots.add(pluginRoot(source));
    const specifier = `${fileURLToPath(source)}?hot=${++generation}`;
    return Effect.tryPromise({ try: () => import(specifier), catch: String });
  }).pipe(Effect.flatMap(decodePlugin));

/** The one place a module becomes a plugin, however it was imported. */
export const decodePlugin = (module: unknown): Effect.Effect<PluginDefinition, string> =>
  S.decodeUnknown(PluginModule)(module).pipe(
    Effect.map((decoded) => decoded.default),
    Effect.mapError((error) => error.message),
  );

const PluginModule = S.Struct({
  default: S.Struct({
    id: S.NonEmptyString,
    apiVersion: S.String,
    effect: S.declare(
      (input: unknown): input is PluginDefinition["effect"] => typeof input === "function",
      { identifier: "PluginEffect" },
    ),
  }),
});
