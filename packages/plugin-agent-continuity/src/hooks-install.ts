/**
 * Shared install/uninstall helpers for foreign-harness hook assets.
 * Managed files carry AMUX_INTEGRATION_* markers; uninstall refuses unmarked files.
 */
import { Effect, Option, Result, Schema as S } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path computation, not I/O.
import { dirname, join } from "node:path";
import { ForeignHarnessHookError } from "@danielfgray/amux";
import { JsonValueSchema, type JsonValue } from "@danielfgray/amux/protocol";

export const INTEGRATION_ID_MARKER = "AMUX_INTEGRATION_ID=";
export const INTEGRATION_VERSION_MARKER = "AMUX_INTEGRATION_VERSION=";
export const MANAGED_MARKER = "AMUX_AGENT_STATE_PLUGIN=1";

export const homeDir = (): string => {
  // @effect-diagnostics-next-line processEnv:off -- default-argument fallback outside Effect.
  return process.env.HOME ?? ".";
};

export const parseIntegrationVersion = (content: string): number | undefined => {
  for (const line of content.split("\n")) {
    const trimmed = line.replace(/^[\s#/;*]+/, "").trim();
    if (trimmed.startsWith(INTEGRATION_VERSION_MARKER)) {
      const raw = trimmed.slice(INTEGRATION_VERSION_MARKER.length).trim();
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
};

export const isManagedHookContent = (content: string): boolean =>
  content.includes(MANAGED_MARKER) || content.includes(INTEGRATION_ID_MARKER);

export const shellSingleQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

export const hookCommand = (hookPath: string, action?: string): string => {
  const base = `bash ${shellSingleQuote(hookPath)}`;
  return action === undefined ? base : `${base} ${action}`;
};

/** Mutable JSON object — foreign settings files keep unknown sibling keys. */
export type JsonObject = { [key: string]: JsonValue };

const JsonObjectSchema = S.Record(S.String, JsonValueSchema);

const HookCommandSchema = S.Struct({
  type: S.String,
  command: S.String,
  timeout: S.optionalKey(S.Finite),
});

const NestedHookEntrySchema = S.Struct({
  matcher: S.optionalKey(S.String),
  hooks: S.Array(HookCommandSchema),
});

const parseJsonObject = (
  content: string,
  path: string,
): Effect.Effect<JsonObject, ForeignHarnessHookError> =>
  S.decodeEffect(S.fromJsonString(JsonObjectSchema))(content).pipe(
    Effect.map((decoded) => ({ ...decoded }) satisfies JsonObject),
    Effect.mapError(
      () => new ForeignHarnessHookError({ message: `failed to parse JSON object at ${path}` }),
    ),
  );

export const writeManagedFile = (
  path: string,
  source: Uint8Array | string,
  mode?: number,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}`;
    if (typeof source === "string") yield* fs.writeFileString(temporaryPath, source);
    else yield* fs.writeFile(temporaryPath, source);
    if (mode !== undefined) yield* fs.chmod(temporaryPath, mode);
    yield* fs.rename(temporaryPath, path);
  });

export const removeManagedFile = (
  path: string,
): Effect.Effect<boolean, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(path).pipe(Effect.result);
    if (Result.isFailure(content)) {
      if (content.failure.reason._tag === "NotFound") return false;
      return yield* content.failure;
    }
    if (!isManagedHookContent(content.success)) {
      return yield* new ForeignHarnessHookError({
        message: `refusing to remove unrecognised file at ${path}`,
      });
    }
    yield* fs.remove(path);
    return true;
  });

const asHookEntries = (value: JsonValue | undefined) => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    Option.match(S.decodeUnknownOption(NestedHookEntrySchema)(entry), {
      onNone: () => [],
      onSome: (decoded) => [decoded],
    }),
  );
};

const entriesAsJson = (entries: readonly (typeof NestedHookEntrySchema.Type)[]): JsonValue =>
  S.encodeSync(S.Array(NestedHookEntrySchema))(entries);

/** Ensure a nested command hook (claude/codex SessionStart shape). Idempotent. */
export const ensureNestedCommandHook = (
  hooks: JsonObject,
  event: string,
  command: string,
  timeout: number,
  matcher?: string,
): void => {
  const entries = [...asHookEntries(hooks[event])];
  const already = entries.some((entry) =>
    entry.hooks.some((hook) => hook.type === "command" && hook.command === command),
  );
  if (already) {
    hooks[event] = entriesAsJson(entries);
    return;
  }
  const hook = { type: "command", command, timeout } as const satisfies typeof HookCommandSchema.Type;
  const entry =
    matcher === undefined
      ? ({ hooks: [hook] } as const satisfies typeof NestedHookEntrySchema.Type)
      : ({ matcher, hooks: [hook] } as const satisfies typeof NestedHookEntrySchema.Type);
  entries.push(entry);
  hooks[event] = entriesAsJson(entries);
};

/** Remove nested command hooks whose command matches any of `commands`. */
export const removeNestedCommandHooks = (
  hooks: JsonObject,
  event: string,
  commands: readonly string[],
): boolean => {
  const entries = asHookEntries(hooks[event]);
  if (entries.length === 0) return false;
  let removed = false;
  const next = entries.flatMap((entry) => {
    const kept = entry.hooks.filter((hook) => {
      const match = hook.type === "command" && commands.includes(hook.command);
      if (match) removed = true;
      return !match;
    });
    return kept.length === 0 ? [] : [{ ...entry, hooks: kept }];
  });
  if (next.length === 0) delete hooks[event];
  else hooks[event] = entriesAsJson(next);
  return removed;
};

/** Cursor hooks.json: flat `{ "command": "..." }` entries (docs/hooks). */
const SimpleHookEntrySchema = S.Struct({
  command: S.String,
});

const asSimpleHookEntries = (value: JsonValue | undefined) => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    Option.match(S.decodeUnknownOption(SimpleHookEntrySchema)(entry), {
      onNone: () => [],
      onSome: (decoded) => [decoded],
    }),
  );
};

/** Idempotent install of a Cursor-style simple command hook. */
export const ensureSimpleCommandHook = (
  hooks: JsonObject,
  event: string,
  command: string,
): void => {
  const entries = [...asSimpleHookEntries(hooks[event])];
  if (entries.some((entry) => entry.command === command)) {
    hooks[event] = S.encodeSync(S.Array(SimpleHookEntrySchema))(entries);
    return;
  }
  entries.push({ command });
  hooks[event] = S.encodeSync(S.Array(SimpleHookEntrySchema))(entries);
};

/** Remove Cursor-style simple command hooks matching `command`. */
export const removeSimpleCommandHook = (
  hooks: JsonObject,
  event: string,
  command: string,
): boolean => {
  const entries = asSimpleHookEntries(hooks[event]);
  if (entries.length === 0) return false;
  const next = entries.filter((entry) => entry.command !== command);
  if (next.length === entries.length) return false;
  if (next.length === 0) delete hooks[event];
  else hooks[event] = S.encodeSync(S.Array(SimpleHookEntrySchema))(next);
  return true;
};

export const readOrEmptyJsonObject = (
  path: string,
): Effect.Effect<
  { readonly content: string; readonly value: JsonObject },
  PlatformError | ForeignHarnessHookError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* fs.readFileString(path).pipe(Effect.result);
    if (Result.isFailure(existing)) {
      if (existing.failure.reason._tag === "NotFound") return { content: "{}", value: {} };
      return yield* existing.failure;
    }
    return {
      content: existing.success,
      value: yield* parseJsonObject(existing.success, path),
    };
  });

export const writeJsonObject = (
  path: string,
  value: JsonObject,
): Effect.Effect<void, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  S.encodeEffect(S.fromJsonString(JsonObjectSchema, { space: 2 }))(value).pipe(
    Effect.mapError(
      () => new ForeignHarnessHookError({ message: `failed to encode JSON at ${path}` }),
    ),
    Effect.flatMap((text) => writeManagedFile(path, `${text}\n`)),
  );

export const ensureHooksObject = (root: JsonObject): JsonObject =>
  Option.match(
    Option.flatMap(Option.fromNullishOr(root.hooks), (hooks) =>
      S.decodeUnknownOption(JsonObjectSchema)(hooks),
    ),
    {
      onNone: () => {
        const created = {} satisfies JsonObject;
        root.hooks = created;
        return created;
      },
      onSome: (hooks) => {
        const mutable = { ...hooks } satisfies JsonObject;
        root.hooks = mutable;
        return mutable;
      },
    },
  );

export const requireConfigDirectory = (
  dir: string,
  label: string,
): Effect.Effect<void, PlatformError | ForeignHarnessHookError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(dir).pipe(Effect.result);
    if (Result.isFailure(info) || info.success.type !== "Directory") {
      return yield* new ForeignHarnessHookError({
        message: `${label} not found at ${dir}`,
      });
    }
  });

export const configPath = (...parts: string[]): string => join(...parts);

/**
 * Ensure `[features]` contains `hooks = true` for Codex. Line-oriented so we
 * do not rewrite unrelated TOML; mirrors herdr's build_codex_config_with_hooks.
 */
export const buildCodexConfigWithHooks = (content: string): string => {
  const trailingNewline = content.endsWith("\n");
  const lines = content.length === 0 ? [] : content.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();

  let inFeatures = false;
  let featuresHeaderIndex: number | undefined;
  let hooksIndex: number | undefined;
  const deprecated: number[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1]?.trim();
    if (header !== undefined) {
      inFeatures = header === "features";
      if (inFeatures && featuresHeaderIndex === undefined) featuresHeaderIndex = index;
      continue;
    }
    if (!inFeatures) continue;
    const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
    if (key === "codex_hooks") deprecated.push(index);
    else if (key === "hooks") hooksIndex = index;
  }

  if (hooksIndex !== undefined) lines[hooksIndex] = "hooks = true";
  for (const index of deprecated.reverse()) lines.splice(index, 1);

  if (hooksIndex === undefined) {
    if (featuresHeaderIndex !== undefined) lines.splice(featuresHeaderIndex + 1, 0, "hooks = true");
    else {
      if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
      lines.push("[features]", "hooks = true");
    }
  }

  const joined = lines.join("\n");
  return trailingNewline || joined.length > 0 ? `${joined}\n` : joined;
};
