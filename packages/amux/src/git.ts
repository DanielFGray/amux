/**
 * Branch mark, ahead/behind, and worktree operations for a space's directory.
 */
import * as Path from "effect/Path";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { pipe } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
}

const EMPTY: GitInfo = { branch: "", ahead: 0, behind: 0 };

export function readGit(dir: string): Promise<GitInfo> {
  return Effect.runPromise(
    Effect.tryPromise(() => git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).pipe(
      Effect.flatMap((branch) => {
        if (!branch) return Effect.succeed(EMPTY);
        if (branch === "HEAD")
          return Effect.tryPromise(() => git(["rev-parse", "--short", "HEAD"], dir)).pipe(
            Effect.map((sha) => ({
              branch: sha ? `(${sha})` : "(detached)",
              ahead: 0,
              behind: 0,
            })),
          );
        return Effect.tryPromise(() =>
          git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], dir),
        ).pipe(
          Effect.map((counts) => {
            const [behind = "0", ahead = "0"] = counts.trim().split(/\s+/);
            return { branch, ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
          }),
          Effect.orElseSucceed(() => ({ branch, ahead: 0, behind: 0 })),
        );
      }),
      Effect.orElseSucceed(() => EMPTY),
    ),
  );
}

export interface WorktreeSpec {
  branch: string;
  base?: string;
}

export const worktreeDirname = (branch: string): string => branch.replace(/\//g, "-");

/**
 * The project a directory belongs to: the repository, not the checkout.
 *
 * `--git-common-dir` answers with the main repository's `.git` from inside any
 * linked worktree, so every worktree of one repo resolves to one project — the
 * unit a permission rule or a conversation is scoped to. A directory that is
 * not in a repository is its own project, which keeps the notion total.
 */
export function projectRoot(dir: string): Promise<string> {
  const path = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
  return Effect.runPromise(
    Effect.tryPromise(() =>
      git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir),
    ).pipe(
      Effect.map((common) => (common ? path.dirname(common) : path.resolve(dir))),
      Effect.orElseSucceed(() => path.resolve(dir)),
    ),
  );
}

/** Imperative git operations for daemon-side use. The daemon runs outside the
 *  client's Effect scope and calls these through its promise queue.
 *
 *  Calls are bounded: a hung git (network share, NFS stall) must not wedge the
 *  model-queue head, so the subprocess is killed after #GIT_TIMEOUT_MS. */
const GIT_TIMEOUT_MS = 10_000;

class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
}) {}

interface GitResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

const runGit = (args: string[], cwd: string, timeoutMs: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const process = yield* spawner.spawn(
        pipe(
          ChildProcess.make("git", args, { stdout: "pipe", stderr: "pipe" }),
          ChildProcess.setCwd(cwd),
          // amux observes a repository it does not own. `git status` would
          // otherwise take .git/index.lock to refresh the index, so a poll
          // landing between the user's own `git add` and `git commit` makes
          // their command fail — and a poll killed mid-refresh leaves the
          // lock behind. This disables only the locks git takes for its own
          // convenience; the ones an operation requires are unaffected.
          ChildProcess.setEnv({ GIT_OPTIONAL_LOCKS: "0" }),
        ),
      );
      const stdout = yield* Effect.forkChild(
        Stream.decodeText()(process.stdout).pipe(Stream.runCollect),
      );
      const stderr = yield* Effect.forkChild(
        Stream.decodeText()(process.stderr).pipe(Stream.runCollect),
      );
      const code = yield* Effect.timeoutOrElse(process.exitCode, {
        duration: `${timeoutMs} millis`,
        orElse: () => new GitError({ message: `git ${args[0]} timed out after ${timeoutMs}ms` }),
      });
      const out = yield* Fiber.join(stdout);
      const err = yield* Fiber.join(stderr);
      return {
        code,
        out: out.join("").trim(),
        err: err.join("").trim(),
      };
    }),
  ).pipe(Effect.provide(BunServices.layer));

function runGitResult(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return Effect.runPromiseExit(runGit(args, cwd, timeoutMs)).then((result) =>
    Exit.match(result, {
      onFailure: (cause) => Promise.reject(Cause.squash(cause)),
      onSuccess: (value) => value,
    }),
  );
}

export function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return runGitResult(args, cwd, timeoutMs).then(({ code, out, err }) => {
    if (code !== 0) throw new GitError({ message: err || `git ${args[0]} failed` });
    return out;
  });
}

/** Exit code 0 (yes) or 1 (no) only; any other code is a repository error and
 *  must not be read as a quiet "no". */
function gitExitCode(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<number> {
  return runGitResult(args, cwd, timeoutMs).then(({ code, err }) => {
    if (code !== 0 && code !== 1) throw new GitError({ message: err || `git ${args[0]} failed` });
    return code;
  });
}

function branchExists(repo: string, branch: string): Promise<boolean> {
  return gitExitCode(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo).then(
    (code) => code === 0,
  );
}

function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitExitCode(["merge-base", "--is-ancestor", ancestor, descendant], repo).then(
    (code) => code === 0,
  );
}

/** Create a new branch and a worktree checked out to it, or re-attach an
 *  existing branch. Branch creation is the point of a space worktree:
 *  `git worktree add <path> <branch>` would only attach an existing branch,
 *  which is not how a fresh space starts.
 *
 *  An existing branch is advanced to `base` before the worktree is created when
 *  that is safe — the branch is a plain ancestor of `base`, so no commits are
 *  lost — which re-creates a stale empty branch at the requested base instead of
 *  handing back the obsolete tip it was left at. A branch that has diverged from
 *  `base` holds work, so it is left where it is and checked out as-is. An
 *  explicit base is never dropped: it is either applied, or refused by git
 *  (advancing a checked-out branch, an unresolvable base) and surfaced as an
 *  error. */
export function gitWorktreeAdd(repo: string, spec: WorktreeSpec, path: string): Promise<void> {
  return branchExists(repo, spec.branch).then((exists) => {
    if (!exists) {
      const args = ["worktree", "add", "-b", spec.branch, path];
      if (spec.base) args.push(spec.base);
      return git(args, repo).then(() => undefined);
    }
    return Promise.resolve(spec.base && isAncestor(repo, spec.branch, spec.base))
      .then((ancestor) =>
        ancestor ? git(["branch", "-f", spec.branch, spec.base!], repo) : undefined,
      )
      .then(() => git(["worktree", "add", path, spec.branch], repo))
      .then(() => undefined);
  });
}

/** The repo is the cwd: a worktree being removed cannot be the git invocation's
 *  own working directory. Removal must run from a sibling worktree or the
 *  repository itself. */
export function gitWorktreeRemove(repo: string, path: string, force = false): Promise<void> {
  const args = force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path];
  return git(args, repo).then(() => undefined);
}

export function gitWorktreeDirty(path: string): Promise<boolean> {
  return git(["status", "--porcelain"], path).then((out) => out.length > 0);
}

export function gitWorktreeExists(path: string): Promise<boolean> {
  return git(["rev-parse", "--git-dir"], path)
    .then((out) => out.length > 0)
    .catch(() => false);
}
