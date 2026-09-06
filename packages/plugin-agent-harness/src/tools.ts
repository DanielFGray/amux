import { Tool, Toolkit } from "effect/unstable/ai";
import { BunFileSystem } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Duration, Effect, Layer, Schema as S } from "effect";
import { bashResources, pathResource, type PermissionGate } from "./permission.ts";
import { nestedInstructions } from "./context.ts";
import type { Interface as ProjectStoreInterface } from "@danielfgray/amux/project-store.ts";
import type { JsonValue } from "@danielfgray/amux";

/** What `agentToolkit` needs from a project store to attach nested instructions. */
type InstructionStore = Pick<ProjectStoreInterface, "attachedInstructions" | "attachInstructions">;

const DEFAULT_LIMIT = 2_000;
const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;

const Read = Tool.make("read", {
  description: "Read a text file or list a directory. Relative paths resolve from the workspace.",
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

/**
 * The five tools, each declaring what it is about to do before it does it.
 *
 * Only the tool knows what its own arguments mean, so the assertion is written
 * here rather than derived from the call by a layer above: `read` on a directory
 * is still a read, and `bash` names shell segments, not files.
 */
export const agentToolkit = Effect.fnUntraced(function* (
  workspace: string,
  gate: PermissionGate,
  instructions: { readonly session: string; readonly store: InstructionStore },
) {
  const toolkit = Toolkit.make(Read, Write, Glob, Grep, Bash);
  /** Clear the call, then run it. A refusal is the tool's failure text. */
  const gated = <E>(
    tool: string,
    action: string,
    resources: readonly string[],
    input: JsonValue,
    body: Effect.Effect<string, E, FileSystem.FileSystem | Path.Path>,
  ) =>
    gate
      .assert({ tool, action, resources, input })
      .pipe(
        Effect.andThen(
          tryTool(body.pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, Path.layer)))),
        ),
      );
  const paths = (...values: string[]) =>
    Effect.forEach(values, (value) =>
      pathResource(workspace, fromWorkspace(workspace, value)),
    ).pipe(Effect.provide(Path.layer));
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
      Effect.provide(Layer.mergeAll(BunFileSystem.layer, Path.layer)),
      // Attachment is best-effort: a store hiccup should not fail the tool call.
      Effect.orElseSucceed(() => ""),
    );
  const withNested = (directory: string, result: string) =>
    attachNested(directory).pipe(
      Effect.map((prefix) => (prefix ? `${prefix}\n\n${result}` : result)),
    );
  const handlers = toolkit.of({
    read: (input) =>
      Effect.gen(function* () {
        const resources = yield* paths(input.path);
        return yield* gated(
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
            const lines = (yield* fs.readFileString(target)).split("\n");
            const start = Math.max(0, (offset ?? 1) - 1);
            return yield* withNested(
              directory,
              lines
                .slice(start, start + (limit ?? DEFAULT_LIMIT))
                .map((line, index) => `${start + index + 1}: ${line}`)
                .join("\n"),
            );
          }),
        );
      }),
    write: (input) =>
      Effect.gen(function* () {
        const resources = yield* paths(input.path);
        return yield* gated(
          "write",
          "write",
          resources,
          input,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const target = fromWorkspace(workspace, input.path);
            const directory = path.dirname(target);
            yield* fs.makeDirectory(directory, { recursive: true });
            yield* fs.writeFileString(target, input.content);
            return yield* withNested(directory, `Wrote ${target}`);
          }),
        );
      }),
    glob: (input) =>
      Effect.gen(function* () {
        const resources = yield* paths(input.path ?? ".");
        return yield* gated(
          "glob",
          "read",
          resources,
          input,
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const root = fromWorkspace(workspace, input.path ?? ".");
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
        );
      }),
    grep: (input) =>
      Effect.gen(function* () {
        const resources = yield* paths(input.path ?? ".");
        return yield* gated(
          "grep",
          "read",
          resources,
          input,
          Effect.gen(function* () {
            const args = [
              "rg",
              "--line-number",
              "--color=never",
              "--max-count",
              String(input.limit ?? DEFAULT_LIMIT),
            ];
            if (input.include) args.push("--glob", input.include);
            const directory = fromWorkspace(workspace, input.path ?? ".");
            args.push("--", input.pattern, directory);
            const result = yield* run(args, workspace, DEFAULT_TIMEOUT);
            if (result.exit === 1) return yield* withNested(directory, "No files found");
            if (result.exit !== 0)
              throw new Error(result.output || `rg exited with code ${result.exit}`);
            return yield* withNested(directory, result.output || "No files found");
          }),
        );
      }),
    // The workdir is where the command runs, but what is judged is the command:
    // a rule about `git status` is about the words, not the directory.
    bash: (input) =>
      gated(
        "bash",
        "bash",
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
      ),
  });
  return yield* toolkit.pipe(
    Effect.provide(
      toolkit.toLayer(handlers).pipe(Layer.provide(BunFileSystem.layer), Layer.provide(Path.layer)),
    ),
  );
});

const tryTool = <E>(body: Effect.Effect<string, E>) =>
  body.pipe(Effect.mapError((error) => String(error)));

const fromWorkspace = (workspace: string, path: string) =>
  path.startsWith("/") ? path : `${workspace}/${path}`;

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
