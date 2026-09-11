import { Context, Effect, Option, Predicate, Schema as S } from "effect";
import * as Graph from "effect/Graph";
import { plugin } from "bun";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous by necessity: path math inside Bun's synchronous onResolve hook and the synchronous graph query it feeds, where no Effect runtime exists.
import { dirname, join } from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous by necessity, same call sites as above: the graph query resolves without the resolver (and without its auto-install side effects), which must stay synchronous.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as AmuxPluginApi from "../api.ts";
import * as EffectApi from "effect";
import * as SolidApi from "solid-js";
import * as jsxRuntime from "@opentui/solid/jsx-runtime";
import * as jsxDevRuntime from "@opentui/solid/jsx-dev-runtime";
import type { PluginDefinition } from "./types.ts";
import type { PluginDependency, PluginService } from "./services.ts";

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

/**
 * Specifiers the resolver answers with shared object modules (see
 * `installHotLoader`): they never touch the filesystem, so resolving them
 * would only ask the registry for packages that are already in memory —
 * and Bun asks by printing its installer progress at the terminal, in the
 * middle of a running TUI. Every query path must skip these before
 * resolving anything.
 */
const SHIMMED_SPECIFIERS = {
  amux: AmuxPluginApi,
  effect: EffectApi,
  "solid-js": SolidApi,
  "@opentui/solid/jsx-runtime": jsxRuntime,
  "@opentui/solid/jsx-dev-runtime": jsxDevRuntime,
};

/** A plugin's reloadable half: the directory named after its entry file. */
export const pluginRoot = (source: URL): string =>
  `${fileURLToPath(source).replace(/\.[cm]?[jt]sx?$/, "")}/`;

const roots = new Set<string>();
const batchRoots = new Map<string, readonly string[]>();
let installed = false;
let generation = 0;
/**
 * Raw `(importer file, specifier)` pairs the resolver hook observes.
 *
 * Resolution is deferred to query time on purpose: resolving inside the
 * hook costs milliseconds per edge (13s+ for the harness alone — the
 * startup the trace attributes to the plugin), while resolving the same
 * edges outside it costs ~40ms total. Recording is a map insert, which
 * the import-timing spike measured as indistinguishable from no hook.
 */
const rawEdges = new Map<string, Set<string>>();
let rawEdgeCount = 0;
let imports = Graph.directed<string, void>();
let builtEdges = -1;
/** Every `(base, specifier)` resolution so far, including failures. */
const resolvedCache = new Map<string, string | null>();

/** The resolved module graph observed while importing reloadable plugins. */
export const importGraph = () => {
  ensureGraph();
  return imports;
};

/** The reloadable source closure observed for these entries, including each entry itself. */
export const hotModuleClosure = (sources: readonly URL[]): readonly URL[] => {
  ensureGraph();
  const nodes = new Map<string, Graph.NodeIndex>();
  const urls = new Map<Graph.NodeIndex, string>();
  for (const [index, url] of imports) {
    nodes.set(url, index);
    urls.set(index, url);
  }
  const roots = sources.map(pluginRoot);
  const reloadable = (url: string) =>
    url.startsWith("file:") && roots.some((root) => fileURLToPath(url).startsWith(root));
  const closure = new Set(sources.map((source) => source.href));
  const pending = sources
    .map((source) => nodes.get(source.href))
    .filter((node): node is Graph.NodeIndex => node !== undefined);
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index]!;
    for (const next of Graph.successors(imports, current)) {
      const url = urls.get(next);
      if (!url || !reloadable(url) || closure.has(url)) continue;
      closure.add(url);
      pending.push(next);
    }
  }
  return [...closure].map((url) => new URL(url));
};

/** A set of entries that must share one fresh module-cache generation. */
export interface HotGeneration {
  readonly token: string;
  readonly roots: readonly string[];
}

const resolvedUrl = (path: string): string =>
  path.includes(":") ? new URL(path).href : pathToFileURL(path).href;

/**
 * Resolve one recorded edge without Bun's resolver — and in particular
 * without its fallback auto-install, which prints installer progress at the
 * terminal and, off-network, stalls the query that asked. Returns the
 * target file path, or null when the edge is not a resolvable file.
 *
 * Relative specifiers go through `Bun.resolveSync`: a relative lookup never
 * reaches the registry, so it cannot spray or stall. Bare specifiers are
 * walked through `node_modules` by hand for the same reason; the object
 * modules above and anything unresolvable resolve to nothing, the way the
 * old hook's catch-and-skip did, minus the side effects.
 */
function isFile(target: string): boolean {
  const stats = statSync(target, { throwIfNoEntry: false });
  return stats?.isFile() ?? false;
}

function resolveRecorded(baseDir: string, specifier: string): string | null {
  if (Object.hasOwn(SHIMMED_SPECIFIERS, specifier)) return null;
  try {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const target = Bun.resolveSync(specifier, baseDir);
      return isFile(target) ? target : null;
    }
    if (specifier.startsWith("/") || specifier.startsWith("file:")) {
      const target = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
      return isFile(target) ? target : null;
    }
    return resolveBareSpecifier(specifier, baseDir);
  } catch {
    // This hook observes imports without changing Bun's resolver. A failed
    // resolution remains Bun's error, rather than becoming an HMR-only error.
    return null;
  }
}

/** `exports[subpath]`, with a single `"./*"`-style wildcard substitution —
 *  every shape this repo's own plugin packages declare. Canonical home is
 *  here: the loader resolves configured entries through this too. */
export function resolveExportsSubpath(
  exportsMap: Readonly<Record<string, string>>,
  entrypoint: string,
): string | undefined {
  const direct = exportsMap[entrypoint];
  if (direct !== undefined) return direct;
  for (const [pattern, value] of Object.entries(exportsMap)) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (entrypoint.startsWith(prefix) && entrypoint.endsWith(suffix)) {
      return value.replace("*", entrypoint.slice(prefix.length, entrypoint.length - suffix.length));
    }
  }
  return undefined;
}

const PROBE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** A `node_modules` walk for one bare specifier: up from the importer,
 *  through workspace symlinks, through the target's `exports` map. Sync
 *  filesystem reads only — no resolver, no registry, no network. */
function resolveBareSpecifier(specifier: string, baseDir: string): string | null {
  const slash = specifier.indexOf("/");
  const name =
    specifier.startsWith("@") && slash !== -1
      ? specifier.slice(0, specifier.indexOf("/", slash + 1))
      : slash === -1
        ? specifier
        : specifier.slice(0, slash);
  if (name === "" || name === "." || name === "..") return null;
  const subpath = specifier.slice(name.length) || ".";
  let dir = baseDir;
  for (;;) {
    const stats = statSync(join(dir, "node_modules", name), { throwIfNoEntry: false });
    if (stats !== undefined) {
      const target = resolvePackageTarget(join(dir, "node_modules", name), subpath);
      if (target !== null) return target;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The subset of a package manifest this resolver reads. Non-string `exports`
 *  values (conditional export objects) fall out during decode — this repo's
 *  own plugin packages only ever declare flat string targets. */
const RawManifest = S.Struct({
  exports: S.optionalKey(S.Record(S.String, S.String)),
  main: S.optionalKey(S.String),
  module: S.optionalKey(S.String),
});

function readManifest(packageJsonPath: string): typeof RawManifest.Type {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return Option.getOrElse(S.decodeUnknownOption(RawManifest)(parsed), () => ({}));
  } catch {
    return {};
  }
}

function resolvePackageTarget(packageDir: string, subpath: string): string | null {
  let dir: string;
  try {
    dir = realpathSync(packageDir);
  } catch {
    return null;
  }
  const record = readManifest(join(dir, "package.json"));
  const entrypoint = subpath === "" ? "." : subpath.startsWith(".") ? subpath : `.${subpath}`;
  // Without an exports map the subpath names the file directly — the same
  // file-only fallback the loader gives a manifest without exports.
  const mapped =
    record.exports === undefined ? entrypoint : resolveExportsSubpath(record.exports, entrypoint);
  const mappedFile = typeof mapped === "string" ? mapped : undefined;
  const legacy = record.main ?? record.module ?? "index.js";
  const roots =
    mappedFile === undefined
      ? entrypoint === "." && record.exports === undefined
        ? [join(dir, legacy.replace(/^\.\//, ""))]
        : []
      : [join(dir, mappedFile.replace(/^\.\//, ""))];
  const candidates = [...roots];
  for (const root of roots) {
    const stats = statSync(root, { throwIfNoEntry: false });
    if (stats?.isDirectory() ?? false) {
      for (const extension of PROBE_EXTENSIONS) candidates.push(join(root, `index${extension}`));
    } else if (!/\.[a-z0-9]+$/i.test(root)) {
      for (const extension of PROBE_EXTENSIONS) candidates.push(`${root}${extension}`);
      for (const extension of PROBE_EXTENSIONS) candidates.push(join(root, `index${extension}`));
    }
  }
  return (
    candidates.find((candidate) => {
      const stats = statSync(candidate, { throwIfNoEntry: false });
      return stats?.isFile() ?? false;
    }) ?? null
  );
}

/**
 * Fold the observed raw edges into the queryable graph. Runs only on query
 * paths (reload, checkpoint, file-watch), never during plugin load.
 *
 * The base is the importer's directory: `Bun.resolveSync` resolves relative
 * specifiers against a directory, and a file path silently resolves nothing.
 */
function ensureGraph(): void {
  if (builtEdges === rawEdgeCount) return;
  const pairs: Array<readonly [string, string]> = [];
  for (const [importer, specifiers] of rawEdges) {
    let base: string;
    try {
      base = dirname(importer.includes(":") ? fileURLToPath(importer) : importer);
    } catch {
      continue;
    }
    const from = resolvedUrl(importer);
    for (const specifier of specifiers) {
      const cacheKey = `${base}${specifier}`;
      let to = resolvedCache.get(cacheKey);
      if (to === undefined) {
        const target = resolveRecorded(base, specifier);
        to = target === null ? null : resolvedUrl(target);
        resolvedCache.set(cacheKey, to);
      }
      if (to !== null) pairs.push([from, to]);
    }
  }
  const seen = new Set<string>();
  imports = Graph.mutate(Graph.directed<string, void>(), (graph) => {
    const nodes = new Map<string, Graph.NodeIndex>();
    const node = (url: string) => {
      const existing = nodes.get(url);
      if (existing !== undefined) return existing;
      const added = Graph.addNode(graph, url);
      nodes.set(url, added);
      return added;
    };
    for (const [from, to] of pairs) {
      const edge = `${from} ${to}`;
      if (seen.has(edge)) continue;
      seen.add(edge);
      Graph.addEdge(graph, node(from), node(to), undefined);
    }
  });
  builtEdges = rawEdgeCount;
}

/** Record an edge's raw ends; resolution waits for the first graph query. */
function recordImport(importer: string, specifier: string): void {
  if (!importer) return;
  const from = importer.replace(TOKEN, "");
  let specifiers = rawEdges.get(from);
  if (!specifiers) rawEdges.set(from, (specifiers = new Set()));
  if (!specifiers.has(specifier)) {
    specifiers.add(specifier);
    rawEdgeCount++;
  }
}

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
      // External plugin files have no node_modules to resolve through. These
      // are object modules deliberately, not paths: a compiled Bun binary
      // cannot reliably resolve its bundled sources, and identity must match
      // the host's Effect, Solid, and JSX runtimes.
      for (const [name, exports] of Object.entries(SHIMMED_SPECIFIERS))
        build.module(name, () => ({ exports, loader: "object" as const }));
      build.onResolve({ filter: /.*/ }, (args) => {
        recordImport(args.importer, args.path);
        const carried = TOKEN.exec(args.importer);
        if (!carried) return undefined;
        const importer = args.importer.replace(TOKEN, "");
        // Same no-install rule as the query path: resolving here must never
        // reach the registry, or a reload would spray installer progress
        // across the running TUI the way startup once did.
        const target =
          /^\.\.?\//.test(args.path) || args.path.startsWith("/") || args.path.startsWith("file:")
            ? args.path.startsWith("file:")
              ? fileURLToPath(args.path)
              : args.path.startsWith("/")
                ? args.path
                : new URL(args.path, `file://${importer}`).pathname
            : resolveBareSpecifier(args.path, dirname(importer));
        if (target === null) return undefined;
        const untokened = target.replace(TOKEN, "");
        const batch = batchRoots.get(carried[0]);
        const eligible = batch ?? [...roots];
        for (const root of eligible)
          if (untokened.startsWith(root)) return { path: untokened + carried[0] };
        return undefined;
      });
      // Bun reads a path a plugin resolved exactly as written, so a `.ts`
      // carrying a generation has to be read with it stripped. `.tsx` is
      // deliberately not matched: @opentui/solid's preload already claims those
      // and already strips the query, and taking a component away from that
      // handler would silently produce a UI that never updates.
      build.onLoad({ filter: /\.[cm]?ts\?hot=\d+$/ }, (args) =>
        Bun.file(args.path.replace(TOKEN, ""))
          .text()
          .then((contents) => ({ contents, loader: "ts" })),
      );
    },
  });
}

/** A fresh instance of the plugin whose entry file is `source`. */
export const hotImport = (source: URL): Effect.Effect<PluginDefinition, string> =>
  hotImportIn(source, hotGeneration([source]));

/** One cache key shared by every stale entry and its reloadable dependencies. */
export const hotGeneration = (
  sources: readonly URL[],
  shared: readonly URL[] = [],
): HotGeneration => {
  const token = `?hot=${++generation}`;
  const generationRoots = [
    ...sources.map(pluginRoot),
    ...shared.map((source) => `${dirname(fileURLToPath(source))}/`),
  ];
  batchRoots.set(token, generationRoots);
  return { token, roots: generationRoots };
};

export const hotImportIn = (
  source: URL,
  hot: HotGeneration,
): Effect.Effect<PluginDefinition, string> =>
  Effect.suspend(() => {
    installHotLoader();
    for (const root of hot.roots) roots.add(root);
    return Effect.tryPromise({
      try: () => import(`${fileURLToPath(source)}${hot.token}`),
      catch: String,
    }).pipe(Effect.mapError((error) => `import: ${error}`));
  }).pipe(
    Effect.flatMap((module) =>
      decodePlugin(module).pipe(Effect.mapError((error) => `decode: ${error}`)),
    ),
  );

export const hotImportBatch = (
  sources: readonly URL[],
  shared: readonly URL[] = [],
): Effect.Effect<readonly PluginDefinition[], string> => {
  const hot = hotGeneration(sources, shared);
  return Effect.forEach(sources, (source) => hotImportIn(source, hot));
};

/** The one place a module becomes a plugin, however it was imported. */
export const decodePlugin = (module: unknown): Effect.Effect<PluginDefinition, string> =>
  S.decodeUnknownEffect(PluginModule)(module).pipe(
    Effect.map((decoded) => ({
      ...decoded.default,
      activate: decoded.default.activate as PluginDefinition["activate"],
    })),
    Effect.mapError((error) => error.message),
  );

/**
 * A module is only a plugin if it says so in full.
 *
 * Every field a plugin can declare has to appear here: the struct drops what it
 * does not name, so a field left out would be read from disk and thrown away —
 * a plugin that declares `inject` and silently starts without waiting for it.
 */
const PluginModule = S.Struct({
  default: S.Struct({
    id: S.NonEmptyString,
    inject: S.optional(
      S.Array(
        S.declare<PluginDependency>(
          (input): input is PluginDependency =>
            Context.isKey(input) ||
            (Predicate.isObject(input) && "service" in input && Context.isKey(input.service)),
          { identifier: "PluginDependency" },
        ),
      ),
    ),
    provide: S.optional(
      S.Array(S.declare<PluginService>(Context.isKey, { identifier: "PluginService" })),
    ),
    activate: S.declare(Predicate.isFunction, { identifier: "PluginActivate" }),
  }),
});
