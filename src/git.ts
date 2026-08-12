/**
 * Branch mark, ahead/behind, and worktree operations for a space's directory.
 */
import { dirname, resolve } from "node:path";

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

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(err.trim() || `git ${args[0]} failed`);
    }
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function gitNull(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(err.trim() || `git ${args[0]} failed`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Create a new branch and a worktree checked out to it. Branch creation is the
 *  point of a space worktree: `git worktree add <path> <branch>` would only
 *  attach an existing branch, which is not how a fresh space starts. */
export async function gitWorktreeAdd(
  repo: string,
  spec: WorktreeSpec,
  path: string,
): Promise<void> {
  const args = ["worktree", "add", "-b", spec.branch, path];
  if (spec.base) args.push(spec.base);
  await gitNull(args, repo);
}

/** The repo is the cwd: a worktree being removed cannot be the git invocation's
 *  own working directory. Removal must run from a sibling worktree or the
 *  repository itself. */
export async function gitWorktreeRemove(repo: string, path: string, force = false): Promise<void> {
  const args = force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path];
  await gitNull(args, repo);
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
