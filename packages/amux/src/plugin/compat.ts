import * as FileSystem from "effect/FileSystem";
import { Effect, Schema as S } from "effect";
import { fileURLToPath } from "node:url";

/**
 * The plugin host's own version, checked against a plugin package's
 * `engines.amux` range (mirroring opencode's `engines.opencode`). Kept as a
 * const beside the check rather than imported from package.json so the
 * compiled binary cannot disagree with its own bundle about what it
 * supports; a test pins the two together. This replaces the old
 * module-level `apiVersion` declaration: compatibility is a property of the
 * published package, not of each module it contains.
 */
export const AMUX_PLUGIN_HOST_VERSION = "0.1.0";

const ManifestEngines = S.Struct({
  engines: S.optional(
    S.Struct({
      amux: S.optional(S.String),
    }),
  ),
});

type Version = readonly [major: number, minor: number, patch: number];

const parseVersion = (text: string): Version | null => {
  const match = /^v?(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/.exec(text.trim());
  if (!match) return null;
  const parts = match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
};

const compareVersions = (left: Version, right: Version): number =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

/**
 * Whether `host` satisfies an `engines.amux` range. A deliberate subset of
 * npm semver — exact versions, `^`/`~`, comparison operators, and
 * space-separated AND groups — evaluated fail-closed: anything outside the
 * subset (unions, hyphen ranges, tags, wildcards) is unevaluatable rather
 * than guessed at. `Bun.semver.satisfies` is fail-open on malformed input
 * (it accepts `"garbage"`, `"^"`, `"=>0.1.0"`), which is the wrong default
 * for a gate that must refuse on mismatch.
 */
export function satisfiesRange(host: string, range: string): boolean {
  const version = parseVersion(host);
  if (!version) return false;
  const text = range.trim();
  if (text === "" || text === "*") return text === "*";
  if (text.includes("||")) return false;
  const parts = text.split(/\s+/);
  return parts.every((part) => satisfiesComparator(version, part));
}

const satisfiesComparator = (version: Version, part: string): boolean => {
  const match = /^(<=|>=|\^|~|<|>|=)?(.*)$/.exec(part);
  if (!match) return false;
  const op = match[1];
  const rest = match[2] ?? "";
  if (op === undefined) {
    if (rest === "*" || /^[xX]$/.test(rest)) return true;
    const wildcard = /^(v?\d+(?:\.\d+)?)[.]([xX*])$/.exec(rest);
    if (wildcard) {
      const base = parseVersion(wildcard[1]!);
      if (!base) return false;
      const dotCount = (wildcard[1]!.match(/\./g) ?? []).length;
      const upper: Version = dotCount === 0 ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0];
      return (
        compareVersions(version, [base[0], base[1], 0]) >= 0 && compareVersions(version, upper) < 0
      );
    }
    if (/^[xX*][.][xX*]?$/.test(rest)) return true;
    // A partial version ("1", "1.2") means its whole minor/major line.
    const partial = /^v?(\d+)(?:\.(\d+))?$/.exec(rest);
    if (partial) {
      const major = Number(partial[1]);
      const upper: Version =
        partial[2] === undefined ? [major + 1, 0, 0] : [major, Number(partial[2]) + 1, 0];
      const lower: Version =
        partial[2] === undefined ? [major, 0, 0] : [major, Number(partial[2]), 0];
      return compareVersions(version, lower) >= 0 && compareVersions(version, upper) < 0;
    }
    const exact = parseVersion(rest);
    return exact !== null && compareVersions(version, exact) === 0;
  }
  if (op === "^" || op === "~") {
    const base = parseVersion(rest);
    if (!base) return false;
    const upper: Version =
      op === "^"
        ? base[0] > 0
          ? [base[0] + 1, 0, 0]
          : base[1] > 0
            ? [0, base[1] + 1, 0]
            : [0, 0, base[2] + 1]
        : rest.split(".").length >= 3
          ? [base[0], base[1] + 1, 0]
          : [base[0] + 1, 0, 0];
    return compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0;
  }
  // <=, >=, <, >, = need a full version; a partial pins its line's floor.
  const target = parseVersion(rest);
  if (!target) return false;
  const order = compareVersions(version, target);
  switch (op) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    default:
      return order === 0;
  }
};

/**
 * Refuse a plugin whose package declares an `engines.amux` range this host
 * does not satisfy, naming the plugin and the conflict. A plugin with no
 * enclosing package.json — an ad-hoc dev file, an example — carries no
 * range and is not gated. Never partially loads: the caller skips the
 * plugin outright on failure, the same as any other bad spec.
 */
export const checkPluginCompat = (
  source: URL,
  pluginId: string,
): Effect.Effect<void, string, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const found = yield* enclosingEnginesAmux(source);
    if (found.status === "absent") return;
    if (found.status === "broken")
      return yield* Effect.fail(`Plugin '${pluginId}' has an unreadable manifest: ${found.reason}`);
    if (!satisfiesRange(AMUX_PLUGIN_HOST_VERSION, found.range))
      return yield* Effect.fail(
        `Plugin '${pluginId}' requires amux '${found.range}' but this host is '${AMUX_PLUGIN_HOST_VERSION}'`,
      );
  });

type EnclosingManifest =
  | { readonly status: "absent" }
  | { readonly status: "range"; readonly range: string }
  | { readonly status: "broken"; readonly reason: string };

/** The nearest enclosing package.json's `engines.amux`, if it declares one. */
const enclosingEnginesAmux = (
  source: URL,
): Effect.Effect<EnclosingManifest, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let dir = fileURLToPath(new URL(".", source));
    for (;;) {
      const candidate = `${dir.replace(/\/$/, "")}/package.json`;
      const text = yield* fs.readFileString(candidate).pipe(Effect.orElseSucceed(() => null));
      if (text !== null) {
        const parsed: unknown = yield* S.decodeEffect(S.fromJsonString(S.Unknown))(text).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (parsed === null)
          return { status: "broken", reason: `${candidate} is not JSON` } as const;
        const manifest = yield* S.decodeUnknownEffect(ManifestEngines)(parsed).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (manifest === null)
          return { status: "broken", reason: `${candidate} is not a package manifest` } as const;
        if (manifest.engines?.amux === undefined) return { status: "absent" } as const;
        return { status: "range", range: manifest.engines.amux } as const;
      }
      const parent = dir.replace(/\/[^/]+\/$/, "/");
      if (parent === dir) return { status: "absent" } as const;
      dir = parent;
    }
  });
