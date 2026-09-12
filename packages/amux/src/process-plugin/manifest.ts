import { Effect, Match, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { DOCK_SIDES, type Placement } from "../layout.ts";

/**
 * Out-of-process plugin package contract.
 *
 * Inspired by herdr's `herdr-plugin.toml` and cmux's `cmux-plugin.toml`: a
 * directory of argv commands the host launches as separate processes. Not a
 * Cordis in-process plugin, and not a herdr-compatible façade — amux-native
 * names and the amux CLI/socket as the callback API.
 *
 * Manifest format: `amux-plugin.json` (matches host config.json) or
 * `amux-plugin.toml` (herdr/cmux). Exactly one must be present.
 */
export const PROCESS_PLUGIN_MANIFEST_JSON = "amux-plugin.json";
export const PROCESS_PLUGIN_MANIFEST_TOML = "amux-plugin.toml";
/** Accepted manifest filenames, JSON first (amux house format). */
export const PROCESS_PLUGIN_MANIFEST_FILES = [
  PROCESS_PLUGIN_MANIFEST_JSON,
  PROCESS_PLUGIN_MANIFEST_TOML,
] as const;
/** @deprecated Prefer PROCESS_PLUGIN_MANIFEST_TOML / _JSON — kept for existing call sites. */
export const PROCESS_PLUGIN_MANIFEST = PROCESS_PLUGIN_MANIFEST_TOML;

const NonEmpty = S.String.pipe(S.check(S.isMinLength(1)));
const Argv = S.Array(NonEmpty).pipe(S.check(S.isMinLength(1)));

/** Plugin ids: letters, digits, dot, colon, underscore, hyphen (herdr's set). */
const PluginId = NonEmpty.pipe(
  S.check(S.makeFilter((value) => /^[A-Za-z0-9.:_-]+$/.test(value), {
    description: "plugin id",
    message: "must match [A-Za-z0-9.:_-]+",
  })),
);

/** Entrypoint ids: no dots — herdr qualifies as `plugin.id.action`. */
const EntrypointId = NonEmpty.pipe(
  S.check(S.makeFilter((value) => /^[A-Za-z0-9:_-]+$/.test(value), {
    description: "entrypoint id",
    message: "must match [A-Za-z0-9:_-]+",
  })),
);

export const ProcessPluginActionSchema = S.Struct({
  id: EntrypointId,
  title: NonEmpty,
  description: S.optionalKey(NonEmpty),
  command: Argv,
});

/**
 * Amux layout Placement — not herdr's overlay/popup/tab. Open creates the
 * pane then applies setPlacement/setDock (ep-4d545c).
 */
export const ProcessPluginPlacementSchema = S.Literals([
  "tiled",
  "floating",
  ...DOCK_SIDES,
] as const satisfies readonly Placement[]);
export type ProcessPluginPlacement = typeof ProcessPluginPlacementSchema.Type;

export const ProcessPluginPaneSchema = S.Struct({
  id: EntrypointId,
  title: NonEmpty,
  description: S.optionalKey(NonEmpty),
  command: Argv,
  /** Where the pane sits after open. Default tiled (a normal split). */
  placement: ProcessPluginPlacementSchema.pipe(
    S.withDecodingDefaultType(Effect.succeed("tiled" as const)),
  ),
  /**
   * When true, exiting the session restores window focus to the prior pane
   * (`state.last`) — herdr overlay teardown, without a second placement name.
   */
  transient: S.Boolean.pipe(S.withDecodingDefaultType(Effect.succeed(false))),
});

/**
 * Long-lived (or one-shot) argv launched once after the daemon restores the
 * session and the control socket is listening — herdr's `[[startup]]`.
 */
export const ProcessPluginStartupSchema = S.Struct({
  command: Argv,
});

export const ProcessPluginManifestSchema = S.Struct({
  id: PluginId,
  name: NonEmpty,
  version: NonEmpty,
  description: S.optionalKey(NonEmpty),
  actions: S.Array(ProcessPluginActionSchema).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
  panes: S.Array(ProcessPluginPaneSchema).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
  startup: S.Array(ProcessPluginStartupSchema).pipe(S.withDecodingDefaultType(Effect.succeed([]))),
});

export type ProcessPluginAction = typeof ProcessPluginActionSchema.Type;
export type ProcessPluginPane = typeof ProcessPluginPaneSchema.Type;
export type ProcessPluginStartup = typeof ProcessPluginStartupSchema.Type;
export type ProcessPluginManifest = typeof ProcessPluginManifestSchema.Type;

export class ProcessPluginManifestError extends S.TaggedError<ProcessPluginManifestError>()(
  "ProcessPluginManifestError",
  { message: S.String },
) {}

const rejectDuplicateIds = (
  kind: string,
  entries: readonly { readonly id: string }[],
): Effect.Effect<void, ProcessPluginManifestError> => {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      return Effect.fail(
        new ProcessPluginManifestError({
          message: `duplicate ${kind} id '${entry.id}'`,
        }),
      );
    }
    seen.add(entry.id);
  }
  return Effect.void;
};

/** Decode a manifest object (from JSON or TOML parse). */
export const decodeProcessPluginManifest = (
  value: unknown,
): Effect.Effect<ProcessPluginManifest, ProcessPluginManifestError> =>
  S.decodeUnknownEffect(ProcessPluginManifestSchema)(value).pipe(
    Effect.mapError(
      (error) =>
        new ProcessPluginManifestError({
          message: `invalid process-plugin manifest: ${String(error)}`,
        }),
    ),
    Effect.tap((manifest) =>
      Effect.gen(function* () {
        yield* rejectDuplicateIds("action", manifest.actions);
        yield* rejectDuplicateIds("pane", manifest.panes);
      }),
    ),
  );

type ManifestKind = "json" | "toml";

const parseManifestText = (
  kind: ManifestKind,
  text: string,
  manifestPath: string,
): Effect.Effect<unknown, ProcessPluginManifestError> =>
  Match.value(kind).pipe(
    Match.when("json", () =>
      S.decodeEffect(S.fromJsonString(S.Unknown))(text).pipe(
        Effect.mapError(
          (error) =>
            new ProcessPluginManifestError({
              message: `cannot parse ${manifestPath}: ${String(error)}`,
            }),
        ),
      ),
    ),
    Match.when("toml", () =>
      Effect.try({
        try: () => Bun.TOML.parse(text),
        catch: (error) =>
          new ProcessPluginManifestError({
            message: `cannot parse ${manifestPath}: ${String(error)}`,
          }),
      }),
    ),
    Match.exhaustive,
  );

const resolveManifestFile = (
  pluginRoot: string,
): Effect.Effect<
  { readonly path: string; readonly kind: ManifestKind },
  ProcessPluginManifestError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const candidates: Array<{ name: string; kind: ManifestKind; path: string }> = [
      {
        name: PROCESS_PLUGIN_MANIFEST_JSON,
        kind: "json",
        path: path.join(pluginRoot, PROCESS_PLUGIN_MANIFEST_JSON),
      },
      {
        name: PROCESS_PLUGIN_MANIFEST_TOML,
        kind: "toml",
        path: path.join(pluginRoot, PROCESS_PLUGIN_MANIFEST_TOML),
      },
    ];
    const present: typeof candidates = [];
    for (const candidate of candidates) {
      const exists = yield* fs.exists(candidate.path).pipe(
        Effect.mapError(
          (error) =>
            new ProcessPluginManifestError({
              message: `cannot stat ${candidate.path}: ${String(error)}`,
            }),
        ),
      );
      if (exists) present.push(candidate);
    }
    if (present.length === 0) {
      return yield* new ProcessPluginManifestError({
        message: `no process-plugin manifest in ${pluginRoot} (expected ${PROCESS_PLUGIN_MANIFEST_JSON} or ${PROCESS_PLUGIN_MANIFEST_TOML})`,
      });
    }
    if (present.length > 1) {
      return yield* new ProcessPluginManifestError({
        message: `ambiguous process-plugin manifest in ${pluginRoot}: both ${PROCESS_PLUGIN_MANIFEST_JSON} and ${PROCESS_PLUGIN_MANIFEST_TOML} present; keep one`,
      });
    }
    const chosen = present[0]!;
    return { path: chosen.path, kind: chosen.kind };
  });

/** Read and validate `amux-plugin.json` or `amux-plugin.toml` from a plugin directory. */
export const loadProcessPluginManifest = (
  pluginRoot: string,
): Effect.Effect<
  ProcessPluginManifest,
  ProcessPluginManifestError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { path: manifestPath, kind } = yield* resolveManifestFile(pluginRoot);
    const text = yield* fs.readFileString(manifestPath).pipe(
      Effect.mapError(
        (error) =>
          new ProcessPluginManifestError({
            message: `cannot read ${manifestPath}: ${String(error)}`,
          }),
      ),
    );
    const parsed = yield* parseManifestText(kind, text, manifestPath);
    return yield* decodeProcessPluginManifest(parsed);
  });
