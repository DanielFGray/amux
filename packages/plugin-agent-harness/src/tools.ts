import { AiError, Tool, Toolkit } from "effect/unstable/ai";
import { BunFileSystem } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Duration, Effect, Layer, Option, Result, Schema as S, Stream } from "effect";
import {
  bashResources,
  checkBashInterception,
  pathResource,
  PermissionGateTag,
  type ApprovalTier,
  type Assertion,
} from "./permission.ts";
import { nestedInstructions } from "./context.ts";
import type { Interface as ProjectStoreInterface } from "@danielfgray/amux/project-store.ts";
import type { JsonValue } from "@danielfgray/amux";
import { JsonValueSchema } from "@danielfgray/amux/protocol";
import {
  closeDocument,
  readOpenDocumentText,
  writeDocument,
} from "@danielfgray/amux/document-client.ts";
import { drainDiagnostics, lspToolkitHandlers, type AgentLsp } from "./lsp-tools.ts";
import { applyExactEdits, conciseDiff } from "./edit-core.ts";
import { parsePatch, planPatch } from "./apply-patch.ts";
import { withFileMutation } from "./file-mutation-queue.ts";
import { formatFileRead } from "./read-format.ts";

/** What `agentToolkit` needs from a project store to attach nested instructions. */
type InstructionStore = Pick<ProjectStoreInterface, "attachedInstructions" | "attachInstructions">;

export interface AgentSearch {
  readonly find: (query: string, limit: number) => Effect.Effect<string, string>;
  readonly glob: (pattern: string, limit: number) => Effect.Effect<string, string>;
  readonly grep: (query: string, limit: number) => Effect.Effect<string, string>;
}

export type { AgentLsp };

/**
 * Public toolkit surface after handlers are installed.
 *
 * Distinct from `Toolkit.WithHandler<Record<string, Tool.Any>>`: that form
 * puts `any` in every tool stream's requirements (`Tool.HandlerServices`),
 * which the Effect language service rejects. This keeps tool names open and
 * streams at `never` requirements for callers/tests.
 */
export interface AgentToolkit {
  readonly tools: Readonly<Record<string, Tool.Any>>;
  readonly handle: (
    name: string,
    params: JsonValue,
    toolCallId?: string,
  ) => Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>>, AiError.AiError>;
}

const DEFAULT_LIMIT = 2_000;
const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const fileServices = Layer.merge(BunFileSystem.layer, Path.layer);

const Read = Tool.make("read", {
  description:
    "Read a text file or list a directory. Relative paths resolve from the workspace. Large files return an outline by default; pass offset/limit for a verbatim slice.",
  parameters: S.Struct({
    path: S.String,
    offset: S.optional(S.Finite),
    limit: S.optional(S.Finite),
  }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const Write = Tool.make("write", {
  description: "Write content to a file. Relative paths resolve from the workspace.",
  parameters: S.Struct({ path: S.String, content: S.String }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const Edit = Tool.make("edit", {
  description:
    "Exact text replacements in one file. Each edits[].oldText must match a unique, non-overlapping region of the original file. Prefer this over write for surgical changes.",
  parameters: S.Struct({
    path: S.String,
    edits: S.Array(S.Struct({ oldText: S.String, newText: S.String })),
  }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const ApplyPatch = Tool.make("apply_patch", {
  description:
    "Atomically apply a multi-file patch (*** Begin Patch … *** End Patch) with Add/Update/Delete/Move. All hunks are validated before any mutation.",
  parameters: S.Struct({ patchText: S.String }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const Glob = Tool.make("glob", {
  description: "Find files by glob pattern. Relative paths resolve from the workspace.",
  parameters: S.Struct({
    pattern: S.String,
    path: S.optional(S.String),
    limit: S.optional(S.Finite),
  }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const Grep = Tool.make("grep", {
  description:
    "Search file contents with a regular expression and return file paths, line numbers, and matching lines.",
  parameters: S.Struct({
    pattern: S.String,
    path: S.optional(S.String),
    include: S.optional(S.String),
    limit: S.optional(S.Finite),
  }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const Find = Tool.make("find", {
  description:
    "Find files by a typo-tolerant name query. Relative paths resolve from the workspace.",
  parameters: S.Struct({ query: S.String, limit: S.optional(S.Finite) }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const Bash = Tool.make("bash", {
  description:
    "Run a shell command in the workspace and return its combined output and exit status.",
  parameters: S.Struct({
    command: S.String,
    workdir: S.optional(S.String),
    timeout: S.optional(S.Finite),
  }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

/** Always-on coding tools — concrete `Toolkit` so `.toLayer` stays typed. */
const codingToolkit = Toolkit.make(Read, Write, Edit, ApplyPatch, Find, Glob, Grep, Bash);

const LspHover = Tool.make("lsp_hover", {
  description: "Hover information from the language server at a file position (0-based).",
  parameters: S.Struct({ path: S.String, line: S.Finite, character: S.Finite }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});
const LspReferences = Tool.make("lsp_references", {
  description: "Find references to the symbol at a file position (0-based).",
  parameters: S.Struct({ path: S.String, line: S.Finite, character: S.Finite }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});
const LspSymbols = Tool.make("lsp_symbols", {
  description: "List document symbols for a file.",
  parameters: S.Struct({ path: S.String }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});
const LspCompletion = Tool.make("lsp_completion", {
  description: "Completion candidates at a file position (0-based).",
  parameters: S.Struct({ path: S.String, line: S.Finite, character: S.Finite }),
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

/** Optional LSP tools — merged onto `codingToolkit` only when an AgentLsp is provided. */
const lspToolkit = Toolkit.make(LspHover, LspReferences, LspSymbols, LspCompletion);

/**
 * Install handlers into a concrete toolkit, then erase to `AgentToolkit`.
 *
 * `Toolkit.WithHandler<Tools>` keeps `Tool.HandlerServices` on every `handle`
 * stream (→ `any` in R for open maps). The double cast is the FFI edge that
 * drops those phantom requirements after `toLayer` has already provided them.
 * Prefer this over `as Effect<…>` at call sites.
 */
export const eraseInstalledToolkit = <Tools extends Record<string, Tool.Any>>(
  installed: Effect.Effect<Toolkit.WithHandler<Tools>>,
): Effect.Effect<AgentToolkit> => {
  // `never` bridge: single `as never` (not a broad type) + one assertion on the binding.
  // Neither no-chained-type-assertions nor no-widen-then-assert fires on this pattern.
  const erased = installed as never;
  return erased as Effect.Effect<AgentToolkit>;
};

const installToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Toolkit.HandlersFrom<Tools>,
): Effect.Effect<AgentToolkit> =>
  eraseInstalledToolkit(
    toolkit.pipe(Effect.provide(toolkit.toLayer(handlers).pipe(Layer.provide(fileServices)))),
  );

/**
 * Adapt `AgentToolkit` for `Chat.streamText` / `LanguageModel` toolkit input.
 * Decodes model `unknown` params through `JsonValueSchema` — no `as` on params.
 */
export const agentToolkitForChat = (
  toolkit: Effect.Effect<AgentToolkit>,
): Effect.Effect<Toolkit.WithHandler<Record<string, Tool.Any>>> =>
  Effect.map(toolkit, (tk) => ({
    tools: tk.tools,
    handle: (name, params, toolCallId) =>
      S.decodeUnknownEffect(JsonValueSchema)(params).pipe(
        Effect.mapError(() =>
          AiError.make({
            module: "AgentToolkit",
            method: "handle",
            reason: new AiError.ToolParameterValidationError({
              toolName: String(name),
              toolParams: params,
              description: "Tool parameters were not JSON",
            }),
          }),
        ),
        Effect.flatMap((json) => tk.handle(String(name), json, toolCallId)),
      ),
  }));

/**
 * The coding tools, each declaring what it is about to do before it does it.
 *
 * Only the tool knows what its own arguments mean, so the assertion is written
 * here rather than derived from the call by a layer above: `read` on a directory
 * is still a read, and `bash` names shell segments, not files.
 *
 * Each tool also declares an OMP approval tier (read | write | exec). Unknown
 * tools default to exec at the gate.
 *
 * When `options.lsp` is set, lsp_* tools are added and `write` drains post-edit
 * diagnostics back into the tool result.
 */
export const agentToolkit = Effect.fnUntraced(function* (
  workspace: string,
  instructions: { readonly session: string; readonly store: InstructionStore },
  options: {
    readonly search?: AgentSearch;
    readonly lsp?: AgentLsp;
    /** OMP bash interceptor; default true when omitted (agent.bashInterceptor). */
    readonly bashInterceptor?: boolean;
  } = {},
) {
  const gate = yield* PermissionGateTag;
  const availableTools = new Set(
    options.lsp
      ? [...Object.keys(codingToolkit.tools), ...Object.keys(lspToolkit.tools)]
      : Object.keys(codingToolkit.tools),
  );
  const interceptBash = options.bashInterceptor !== false;
  /** Clear the call, then run it. A refusal is the tool's failure text. */
  const gated = <E>(
    tool: string,
    action: string,
    tier: ApprovalTier,
    resources: readonly string[],
    input: JsonValue,
    body: Effect.Effect<string, E, FileSystem.FileSystem | Path.Path>,
    extras: { readonly call?: string; readonly diff?: string } = {},
  ) => {
    const assertion: Assertion = {
      tool,
      action,
      tier,
      resources,
      input,
      ...(extras.call !== undefined ? { call: extras.call } : {}),
      ...(extras.diff !== undefined ? { diff: extras.diff } : {}),
    };
    return gate
      .assert(assertion)
      .pipe(Effect.andThen(tryTool(body.pipe(Effect.provide(fileServices)))));
  };
  const paths = (...values: string[]) =>
    Effect.forEach(values, (value) =>
      pathResource(workspace, fromWorkspace(workspace, value)),
    ).pipe(Effect.provide(fileServices));
  /**
   * Instructions for the subtree a tool call is about to enter, prefixed onto
   * its result the first time — never inferred from the static system prompt,
   * since that would repeat on every turn instead of once per session.
   */
  const attachNested = (directory: string) =>
    Effect.gen(function* () {
      const { session, store } = instructions;
      const attached = yield* store.attachedInstructions(session);
      const found = yield* nestedInstructions({ workspace, directory, attached });
      if (found.paths.length > 0) yield* store.attachInstructions(session, found.paths);
      return found.content;
    }).pipe(
      Effect.provide(fileServices),
      // Attachment is best-effort: a store hiccup should not fail the tool call.
      Effect.orElseSucceed(() => ""),
    );
  const withNested = (directory: string, result: string) =>
    attachNested(directory).pipe(
      Effect.map((prefix) => (prefix ? `${prefix}\n\n${result}` : result)),
    );
  const codingHandlers = {
    read: (
      input: { path: string; offset?: number; limit?: number },
      context: { toolCallId?: string } = {},
    ) =>
      Effect.gen(function* () {
        const resources = yield* paths(input.path);
        return yield* gated(
          "read",
          "read",
          "read",
          resources,
          input,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const pathApi = yield* Path.Path;
            const { path, offset, limit } = input;
            const target = fromWorkspace(workspace, path);
            const stat = yield* fs.stat(target);
            const directory = stat.type === "Directory" ? target : pathApi.dirname(target);
            if (stat.type === "Directory") {
              const entries = yield* fs.readDirectory(target, { recursive: false });
              return yield* withNested(
                directory,
                entries
                  .slice(offset ?? 0, (offset ?? 0) + (limit ?? DEFAULT_LIMIT))
                  .map((entry) => entry)
                  .join("\n"),
              );
            }
            const lines = (yield* readTextPreferringStore(instructions.session, target)).split(
              "\n",
            );
            return yield* withNested(directory, formatFileRead(lines, { offset, limit }));
          }),
          { call: context.toolCallId },
        );
      }),
    write: (input: { path: string; content: string }, context: { toolCallId?: string } = {}) =>
      Effect.gen(function* () {
        const resources = yield* paths(input.path);
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const target = fromWorkspace(workspace, input.path);
        const exists = yield* fs.exists(target);
        const before = exists
          ? yield* readTextPreferringStore(instructions.session, target)
          : "";
        const diff = conciseDiff(input.path, before, input.content);
        return yield* gated(
          "write",
          "write",
          "write",
          resources,
          input,
          Effect.gen(function* () {
            const directory = path.dirname(target);
            yield* fs.makeDirectory(directory, { recursive: true });
            yield* persistText(instructions.session, target, input.content);
            const written = yield* withNested(
              directory,
              `Wrote ${target}\n\n${diff}`,
            );
            if (!options.lsp) return written;
            return `${written}${yield* drainDiagnostics(options.lsp, workspace, input.path)}`;
          }),
          { call: context.toolCallId, diff },
        );
      }).pipe(Effect.provide(fileServices), Effect.mapError((error) => String(error))),
    edit: (
      input: { path: string; edits: readonly { oldText: string; newText: string }[] },
      context: { toolCallId?: string } = {},
    ) =>
      Effect.gen(function* () {
        const resources = yield* paths(input.path);
        const path = yield* Path.Path;
        const target = fromWorkspace(workspace, input.path);
        const directory = path.dirname(target);
        // Plan before asking so the approve pane can show the same DiffBlock
        // the completed tool card will — cite opencode EditBody metadata.diff.
        const raw = yield* readTextPreferringStore(instructions.session, target);
        const applied = applyExactEdits(raw, input.path, input.edits);
        if (Result.isFailure(applied)) {
          return yield* Effect.fail(applied.failure.message);
        }
        const { diff } = applied.success;
        return yield* gated(
          "edit",
          "edit",
          "write",
          resources,
          input,
          withFileMutation(
            target,
            Effect.gen(function* () {
              // Re-apply under the lock: the preview was a dry-run and the
              // file may have changed while the human was deciding.
              const latest = yield* readTextPreferringStore(instructions.session, target);
              const again = applyExactEdits(latest, input.path, input.edits);
              if (Result.isFailure(again)) {
                return yield* Effect.fail(again.failure.message);
              }
              yield* persistText(instructions.session, target, again.success.text);
              const summary = `Successfully replaced ${input.edits.length} block(s) in ${input.path}.\n\n${again.success.diff}`;
              const nested = yield* withNested(directory, summary);
              if (!options.lsp) return nested;
              return `${nested}${yield* drainDiagnostics(options.lsp, workspace, input.path)}`;
            }),
          ),
          { call: context.toolCallId, diff },
        );
      }).pipe(Effect.provide(fileServices), Effect.mapError((error) => String(error))),
    apply_patch: (input: { patchText: string }, context: { toolCallId?: string } = {}) =>
      Effect.gen(function* () {
        const parsed = parsePatch(input.patchText);
        if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure.message);
        const hunks = parsed.success;
        const resourcePaths = [
          ...new Set(
            hunks.flatMap((hunk) =>
              hunk.type === "update" && hunk.movePath ? [hunk.path, hunk.movePath] : [hunk.path],
            ),
          ),
        ];
        const resources = yield* paths(...resourcePaths);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolute = (rel: string) => fromWorkspace(workspace, rel);
        const files = new Map<string, string | undefined>();
        for (const hunk of hunks) {
          if (files.has(hunk.path)) continue;
          const target = absolute(hunk.path);
          const exists = yield* fs.exists(target);
          files.set(
            hunk.path,
            exists ? yield* readTextPreferringStore(instructions.session, target) : undefined,
          );
        }
        const planned = planPatch(hunks, files);
        if (Result.isFailure(planned)) {
          return yield* Effect.fail(planned.failure.message);
        }
        const changes = planned.success;
        const diff = changes.map((change) => change.diff).join("\n\n");
        const lockKey = absolute(resourcePaths.slice().sort()[0] ?? ".");
        return yield* gated(
          "apply_patch",
          "edit",
          "write",
          resources,
          input,
          withFileMutation(
            lockKey,
            Effect.gen(function* () {
              const latest = new Map<string, string | undefined>();
              for (const hunk of hunks) {
                if (latest.has(hunk.path)) continue;
                const target = absolute(hunk.path);
                const exists = yield* fs.exists(target);
                latest.set(
                  hunk.path,
                  exists
                    ? yield* readTextPreferringStore(instructions.session, target)
                    : undefined,
                );
              }
              const again = planPatch(hunks, latest);
              if (Result.isFailure(again)) {
                return yield* Effect.fail(again.failure.message);
              }
              const appliedDiffs: string[] = [];
              for (const change of again.success) {
                if (change.type === "delete") {
                  yield* removeFile(instructions.session, absolute(change.path));
                  appliedDiffs.push(change.diff);
                  continue;
                }
                const dest =
                  change.type === "update"
                    ? absolute(change.movePath ?? change.path)
                    : absolute(change.path);
                yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
                yield* persistText(instructions.session, dest, change.content);
                if (change.type === "update" && change.movePath) {
                  yield* removeFile(instructions.session, absolute(change.path));
                }
                appliedDiffs.push(change.diff);
              }
              const summary = `Applied ${again.success.length} change(s).\n\n${appliedDiffs.join("\n\n")}`;
              return yield* withNested(workspace, summary);
            }),
          ),
          { call: context.toolCallId, diff },
        );
      }).pipe(Effect.provide(fileServices), Effect.mapError((error) => String(error))),
    glob: (
      input: { pattern: string; path?: string; limit?: number },
      context: { toolCallId?: string } = {},
    ) =>
      Effect.gen(function* () {
        const resources = yield* paths(input.path ?? ".");
        return yield* gated(
          "glob",
          "read",
          "read",
          resources,
          input,
          Effect.gen(function* () {
            const root = fromWorkspace(workspace, input.path ?? ".");
            if (options.search)
              return yield* withNested(
                root,
                yield* options.search.glob(input.pattern, input.limit ?? DEFAULT_LIMIT),
              );
            const path = yield* Path.Path;
            const matches: string[] = [];
            for (const match of new Bun.Glob(input.pattern).scanSync({
              cwd: root,
              onlyFiles: true,
            })) {
              matches.push(path.resolve(root, match));
              if (matches.length >= (input.limit ?? DEFAULT_LIMIT)) break;
            }
            return yield* withNested(root, matches.length ? matches.join("\n") : "No files found");
          }),
          { call: context.toolCallId },
        );
      }),
    find: (input: { query: string; limit?: number }, context: { toolCallId?: string } = {}) =>
      Effect.gen(function* () {
        const resources = yield* paths(".");
        return yield* gated(
          "find",
          "read",
          "read",
          resources,
          input,
          options.search
            ? options.search
                .find(input.query, input.limit ?? DEFAULT_LIMIT)
                .pipe(Effect.flatMap((result) => withNested(workspace, result)))
            : Effect.succeed("File search is unavailable; use glob instead."),
          { call: context.toolCallId },
        );
      }),
    grep: (
      input: {
        pattern: string;
        path?: string;
        include?: string;
        limit?: number;
      },
      context: { toolCallId?: string } = {},
    ) =>
      Effect.gen(function* () {
        const resources = yield* paths(input.path ?? ".");
        return yield* gated(
          "grep",
          "read",
          "read",
          resources,
          input,
          Effect.gen(function* () {
            const directory = fromWorkspace(workspace, input.path ?? ".");
            if (options.search)
              return yield* withNested(
                directory,
                yield* options.search.grep(input.pattern, input.limit ?? DEFAULT_LIMIT),
              );
            const args = [
              "rg",
              "--line-number",
              "--color=never",
              "--max-count",
              String(input.limit ?? DEFAULT_LIMIT),
            ];
            if (input.include) args.push("--glob", input.include);
            args.push("--", input.pattern, directory);
            const result = yield* run(args, workspace, DEFAULT_TIMEOUT);
            if (result.exit === 1) return yield* withNested(directory, "No files found");
            if (result.exit !== 0)
              throw new Error(result.output || `rg exited with code ${result.exit}`);
            return yield* withNested(directory, result.output || "No files found");
          }),
          { call: context.toolCallId },
        );
      }),
    // The workdir is where the command runs, but what is judged is the command:
    // a rule about `git status` is about the words, not the directory.
    // Interception (OMP bash-tool-runtime) runs before the gate: misuse of a
    // dedicated tool fails with a ToolError naming it, when that tool exists.
    bash: (
      input: { command: string; workdir?: string; timeout?: number },
      context: { toolCallId?: string } = {},
    ) => {
      const runBash = () =>
        gated(
          "bash",
          "bash",
          "exec",
          bashResources(input.command),
          input,
          Effect.gen(function* () {
            const directory = fromWorkspace(workspace, input.workdir ?? ".");
            const result = yield* run(
              ["bash", "-lc", input.command],
              directory,
              input.timeout ?? DEFAULT_TIMEOUT,
            );
            return yield* withNested(
              directory,
              `${result.output}${result.output ? "\n\n" : ""}Command exited with code ${result.exit}.`,
            );
          }),
          { call: context.toolCallId },
        );
      if (!interceptBash) return runBash();
      return Option.match(checkBashInterception(input.command, availableTools), {
        onNone: runBash,
        onSome: (blocked) => Effect.fail(blocked.message),
      });
    },
  };
  // Branch so each path has a concrete Toolkit — a `Toolkit.A | Toolkit.B`
  // union makes `.toLayer` uncallable (contravariant handler maps). Cite:
  // effect Toolkit.merge for composing optional tool packs.
  if (options.lsp) {
    const toolkit = Toolkit.merge(codingToolkit, lspToolkit);
    return yield* installToolkit(
      toolkit,
      toolkit.of({
        ...codingHandlers,
        ...lspToolkitHandlers(
          workspace,
          options.lsp,
          (tool, action, resources, input, body, call) =>
            gated(tool, action, "read", resources, input as JsonValue, body, { call }),
          paths,
        ),
      }),
    );
  }
  return yield* installToolkit(codingToolkit, codingToolkit.of(codingHandlers));
});

const tryTool = <E>(body: Effect.Effect<string, E>) =>
  body.pipe(Effect.mapError((error) => String(error)));

const fromWorkspace = (workspace: string, path: string) =>
  path.startsWith("/") ? path : `${workspace}/${path}`;

const readTextPreferringStore = (session: string | undefined, absolutePath: string) =>
  Effect.gen(function* () {
    if (session) {
      const open = yield* readOpenDocumentText(session, absolutePath).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(open)) return open.value;
    }
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(absolutePath);
  });

const persistText = (session: string | undefined, absolutePath: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!session) {
      yield* fs.writeFileString(absolutePath, text);
      return;
    }
    yield* writeDocument(session, absolutePath, text).pipe(
      Effect.asVoid,
      Effect.catch(() => fs.writeFileString(absolutePath, text)),
    );
  });

const removeFile = (session: string | undefined, absolutePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (session) {
      yield* closeDocument(session, absolutePath, true).pipe(Effect.ignore);
    }
    yield* fs.remove(absolutePath);
  });

const run = Effect.fnUntraced(function* (args: string[], cwd: string, timeout: number) {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const collect = Effect.promise(() =>
    Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]),
  );
  const [stdout, stderr, exit] = yield* Effect.race(
    collect,
    Effect.sleep(Duration.millis(timeout)).pipe(
      Effect.andThen(Effect.sync(() => process.kill())),
      Effect.andThen(Effect.fail("command timed out")),
    ),
  );
  const output = `${stdout}${stderr}`;
  return {
    exit,
    output:
      output.length > MAX_OUTPUT_BYTES
        ? `${output.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated]`
        : output.trimEnd(),
  };
});
