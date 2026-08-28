/**
 * Branch mark, ahead/behind, and worktree operations for a space's directory.
 */
import { dirname, resolve } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { pipe } from "effect/Function";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
}

const EMPTY: GitInfo = { branch: "", ahead: 0, behind: 0 };

export async function readGit(dir: string): Promise<GitInfo> {
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
    if (!branch) return EMPTY;
    if (branch === "HEAD") {
      const sha = await git(["rev-parse", "--short", "HEAD"], dir);
      return { branch: sha ? `(${sha})` : "(detached)", ahead: 0, behind: 0 };
    }
    try {
      const counts = await git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], dir);
      const [behind = "0", ahead = "0"] = counts.trim().split(/\s+/);
      return { branch, ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
    } catch {
      // No upstream configured: branch is local-only.
      return { branch, ahead: 0, behind: 0 };
    }
  } catch {
    return EMPTY;
  }
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
export async function projectRoot(dir: string): Promise<string> {
  try {
    const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
    return common ? dirname(common) : resolve(dir);
  } catch {
    return resolve(dir);
  }
}

/** Imperative git operations for daemon-side use. The daemon runs outside the
 *  client's Effect scope and calls these through its promise queue.
 *
 *  Calls are bounded: a hung git (network share, NFS stall) must not wedge the
 *  model-queue head, so the subprocess is killed after #GIT_TIMEOUT_MS. */
const GIT_TIMEOUT_MS = 10_000;

class GitError extends Data.TaggedError("GitError")<{
  readonly message: string;
}> {}

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

async function runGitResult(
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  const result = await Effect.runPromiseExit(runGit(args, cwd, timeoutMs));
  return Exit.match(result, {
    onFailure: (cause) => Promise.reject(Cause.squash(cause)),
    onSuccess: (value) => value,
  });
}

export async function git(
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  const { code, out, err } = await runGitResult(args, cwd, timeoutMs);
  if (code !== 0) throw new GitError({ message: err || `git ${args[0]} failed` });
  return out;
}

/** Exit code 0 (yes) or 1 (no) only; any other code is a repository error and
 *  must not be read as a quiet "no". */
async function gitExitCode(
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<number> {
  const { code, err } = await runGitResult(args, cwd, timeoutMs);
  if (code !== 0 && code !== 1) {
    throw new GitError({ message: err || `git ${args[0]} failed` });
  }
  return code;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (
    (await gitExitCode(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo)) === 0
  );
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await gitExitCode(["merge-base", "--is-ancestor", ancestor, descendant], repo)) === 0;
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
export async function gitWorktreeAdd(
  repo: string,
  spec: WorktreeSpec,
  path: string,
): Promise<void> {
  if (await branchExists(repo, spec.branch)) {
    if (spec.base && (await isAncestor(repo, spec.branch, spec.base))) {
      await git(["branch", "-f", spec.branch, spec.base], repo);
    }
    await git(["worktree", "add", path, spec.branch], repo);
    return;
  }
  const args = ["worktree", "add", "-b", spec.branch, path];
  if (spec.base) args.push(spec.base);
  await git(args, repo);
}

/** The repo is the cwd: a worktree being removed cannot be the git invocation's
 *  own working directory. Removal must run from a sibling worktree or the
 *  repository itself. */
export async function gitWorktreeRemove(repo: string, path: string, force = false): Promise<void> {
  const args = force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path];
  await git(args, repo);
}

export async function gitWorktreeDirty(path: string): Promise<boolean> {
  const out = await git(["status", "--porcelain"], path);
  return out.length > 0;
}

export async function gitWorktreeExists(path: string): Promise<boolean> {
  try {
    const out = await git(["rev-parse", "--git-dir"], path);
    return out.length > 0;
  } catch {
    return false;
  }
}
