import { Tool, Toolkit } from "@effect/ai";
import { Effect, Schema as S } from "effect";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const DEFAULT_LIMIT = 2_000;
const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;

const Read = Tool.make("read", {
  description: "Read a text file or list a directory. Relative paths resolve from the workspace.",
  parameters: {
    path: S.String,
    offset: S.optional(S.Number),
    limit: S.optional(S.Number),
  },
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const Write = Tool.make("write", {
  description: "Write content to a file. Relative paths resolve from the workspace.",
  parameters: { path: S.String, content: S.String },
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const Glob = Tool.make("glob", {
  description: "Find files by glob pattern. Relative paths resolve from the workspace.",
  parameters: {
    pattern: S.String,
    path: S.optional(S.String),
    limit: S.optional(S.Number),
  },
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const Grep = Tool.make("grep", {
  description:
    "Search file contents with a regular expression and return file paths, line numbers, and matching lines.",
  parameters: {
    pattern: S.String,
    path: S.optional(S.String),
    include: S.optional(S.String),
    limit: S.optional(S.Number),
  },
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

const Bash = Tool.make("bash", {
  description:
    "Run a shell command in the workspace and return its combined output and exit status.",
  parameters: {
    command: S.String,
    workdir: S.optional(S.String),
    timeout: S.optional(S.Number),
  },
  success: S.String,
  failure: S.String,
  failureMode: "return",
});

export function agentToolkit(workspace: string) {
  const toolkit = Toolkit.make(Read, Write, Glob, Grep, Bash);
  const handlers = toolkit.of({
    read: ({ path, offset, limit }) =>
      tryTool(async () => {
        const target = fromWorkspace(workspace, path);
        const stat = await Bun.file(target).stat();
        if (stat.isDirectory()) {
          const entries = await readdir(target, { withFileTypes: true });
          return entries
            .slice(offset ?? 0, (offset ?? 0) + (limit ?? DEFAULT_LIMIT))
            .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
            .join("\n");
        }
        const lines = (await readFile(target, "utf8")).split("\n");
        const start = Math.max(0, (offset ?? 1) - 1);
        return lines
          .slice(start, start + (limit ?? DEFAULT_LIMIT))
          .map((line, index) => `${start + index + 1}: ${line}`)
          .join("\n");
      }),
    write: ({ path, content }) =>
      tryTool(async () => {
        const target = fromWorkspace(workspace, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        return `Wrote ${target}`;
      }),
    glob: ({ pattern, path, limit }) =>
      tryTool(async () => {
        const root = fromWorkspace(workspace, path ?? ".");
        const matches: string[] = [];
        for await (const match of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
          matches.push(resolve(root, match));
          if (matches.length >= (limit ?? DEFAULT_LIMIT)) break;
        }
        return matches.length ? matches.join("\n") : "No files found";
      }),
    grep: ({ pattern, path, include, limit }) =>
      tryTool(async () => {
        const args = [
          "rg",
          "--line-number",
          "--color=never",
          "--max-count",
          String(limit ?? DEFAULT_LIMIT),
        ];
        if (include) args.push("--glob", include);
        args.push("--", pattern, fromWorkspace(workspace, path ?? "."));
        const result = await run(args, workspace, DEFAULT_TIMEOUT);
        if (result.exit === 1) return "No files found";
        if (result.exit !== 0)
          throw new Error(result.output || `rg exited with code ${result.exit}`);
        return result.output || "No files found";
      }),
    bash: ({ command, workdir, timeout }) =>
      tryTool(async () => {
        const result = await run(
          ["bash", "-lc", command],
          fromWorkspace(workspace, workdir ?? "."),
          timeout ?? DEFAULT_TIMEOUT,
        );
        return `${result.output}${result.output ? "\n\n" : ""}Command exited with code ${result.exit}.`;
      }),
  });
  return toolkit.pipe(Effect.provide(toolkit.toLayer(handlers)));
}

const tryTool = (body: () => Promise<string>) =>
  Effect.tryPromise({ try: body, catch: (error) => String(error) });

const fromWorkspace = (workspace: string, path: string) =>
  isAbsolute(path) ? path : resolve(workspace, path);

async function run(args: string[], cwd: string, timeout: number) {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => process.kill(), timeout);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const output = `${stdout}${stderr}`;
    return {
      exit,
      output:
        output.length > MAX_OUTPUT_BYTES
          ? `${output.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated]`
          : output.trimEnd(),
    };
  } finally {
    clearTimeout(timer);
  }
}
