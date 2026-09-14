/** @effect-diagnostics *:skip-file -- a real OS boundary (git subprocess, filesystem)
 * this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { expect, test } from "bun:test";
import { stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./test-wait.ts";
import {
  git as effectGit,
  gitWorktreeAdd,
  gitWorktreeDirty,
  gitWorktreeExists,
  gitWorktreeRemove,
  worktreeDirname,
} from "./git.ts";
import { registerCleanup, tempDir } from "./test-tmp.ts";

registerCleanup();

const git = async (args: string[], cwd: string): Promise<string> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
  return out.trim();
};

/** A scratch repository with one initial commit, so worktrees have a base. */
async function initRepo(): Promise<string> {
  const repo = tempDir("repo");
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "t@t.org"], repo);
  await git(["config", "user.name", "T"], repo);
  await writeFile(join(repo, "readme.md"), "groceries\n");
  await git(["add", "readme.md"], repo);
  await git(["commit", "-m", "groceries"], repo);
  return repo;
}

test("git rejects with git's stderr for a nonzero exit", async () => {
  const repo = await initRepo();

  await expect(effectGit(["rev-parse", "not-a-ref"], repo)).rejects.toThrow("not-a-ref");
});

test("git kills a process that exceeds its timeout", async () => {
  const started = Date.now();
  const token = `amux-timeout-${randomUUID()}`;

  await expect(
    effectGit(["hash-object", "--stdin", "--path", token], tmpdir(), 25),
  ).rejects.toThrow("git hash-object timed out after 25ms");

  const survivors = () =>
    Bun.spawnSync(["pgrep", "-f", token], { stdout: "pipe", stderr: "ignore" })
      .stdout.toString()
      .trim()
      .split("\n")
      .filter(Boolean);
  await waitFor(() => survivors().length === 0, "the worktree's processes to exit", 2_000);
  expect(survivors()).toEqual([]);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("git status does not refresh the index, so it never takes index.lock", async () => {
  const repo = await initRepo();
  const file = join(repo, "readme.md");
  const index = join(repo, ".git", "index");

  // Make the working tree newer than the index without changing content. A
  // plain `git status` would then opportunistically refresh the index, taking
  // .git/index.lock and rewriting the index under a new inode. With
  // GIT_OPTIONAL_LOCKS=0 that refresh is skipped, so the index is untouched.
  await utimes(file, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
  const before = (await stat(index)).ino;

  expect(await gitWorktreeDirty(repo)).toBe(false);

  const after = (await stat(index)).ino;
  expect(after).toBe(before);
});

test("gitWorktreeAdd creates a branch and worktree; remove tears it down", async () => {
  const repo = await initRepo();
  const root = tempDir("wt-root");
  const dir = join(root, `abc-${worktreeDirname("feat/x")}`);

  await gitWorktreeAdd(repo, { branch: "feat/x" }, dir);
  expect(await gitWorktreeExists(dir)).toBe(true);
  expect(await Bun.file(join(dir, "readme.md")).exists()).toBe(true);

  await gitWorktreeRemove(repo, dir);
  expect(await gitWorktreeExists(dir)).toBe(false);
});

test("gitWorktreeAdd with a base branches from that commit, and the branch diverges", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "extra.txt"), "base-branch\n");
  await git(["checkout", "-b", "base"], repo);
  await git(["add", "extra.txt"], repo);
  await git(["commit", "-m", "base commit"], repo);
  await git(["checkout", "main"], repo);

  const root = tempDir("wt-root");
  const dir = join(root, `abc-${worktreeDirname("feat/from-base")}`);

  await gitWorktreeAdd(repo, { branch: "feat/from-base", base: "base" }, dir);
  expect(await Bun.file(join(dir, "extra.txt")).exists()).toBe(true);
  expect(await Bun.file(join(dir, "readme.md")).exists()).toBe(true);
  // Branched from 'base', not from the repo's HEAD ('main', no extra.txt).
  expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).toBe("feat/from-base");
  expect(await git(["status", "--porcelain"], dir)).toBe("");
});

test("recreating a removed worktree advances its empty branch to the requested base", async () => {
  const repo = await initRepo();
  const root = tempDir("wt-root");
  const dir = join(root, `abc-${worktreeDirname("feat/redo")}`);

  // First creation leaves branch 'feat/redo' at main's tip; removing the
  // worktree keeps the branch around, empty, at that stale tip.
  await gitWorktreeAdd(repo, { branch: "feat/redo" }, dir);
  await gitWorktreeRemove(repo, dir);
  expect(await gitWorktreeExists(dir)).toBe(false);

  // Trunk advances while the branch sits at the stale tip.
  await writeFile(join(repo, "extra.txt"), "trunk-moved\n");
  await git(["add", "extra.txt"], repo);
  await git(["commit", "-m", "trunk advances"], repo);

  // Re-creating the worktree for the same branch must land at the requested
  // base, not the obsolete tip, because the branch has no divergent work.
  await gitWorktreeAdd(repo, { branch: "feat/redo", base: "main" }, dir);
  expect(await gitWorktreeExists(dir)).toBe(true);
  expect(await Bun.file(join(dir, "extra.txt")).exists()).toBe(true);
  expect(await git(["rev-parse", "feat/redo"], repo)).toBe(await git(["rev-parse", "main"], repo));

  await gitWorktreeRemove(repo, dir);
});

test("gitWorktreeAdd checks out a divergent existing branch as-is, preserving its work", async () => {
  const repo = await initRepo();
  await git(["checkout", "-b", "feat/divergent"], repo);
  await writeFile(join(repo, "work.txt"), "task work\n");
  await git(["add", "work.txt"], repo);
  await git(["commit", "-m", "task work"], repo);
  await git(["checkout", "main"], repo);

  // Trunk advances independently, so the branch now holds divergent work.
  await writeFile(join(repo, "trunk.txt"), "trunk\n");
  await git(["add", "trunk.txt"], repo);
  await git(["commit", "-m", "trunk advances"], repo);

  const root = tempDir("wt-root");
  const dir = join(root, `abc-${worktreeDirname("feat/divergent")}`);

  await gitWorktreeAdd(repo, { branch: "feat/divergent", base: "main" }, dir);
  expect(await gitWorktreeExists(dir)).toBe(true);
  // The divergent commit survives and is checked out; base was not forced over it.
  expect(await Bun.file(join(dir, "work.txt")).exists()).toBe(true);
  expect(await Bun.file(join(dir, "trunk.txt")).exists()).toBe(false);
  expect(await git(["rev-parse", "HEAD"], dir)).toBe(
    await git(["rev-parse", "feat/divergent"], repo),
  );

  await gitWorktreeRemove(repo, dir);
});

test("gitWorktreeRemove refuses a dirty worktree unless forced", async () => {
  const repo = await initRepo();
  const root = tempDir("wt-root");
  const dir = join(root, `abc-${worktreeDirname("feat/dirty")}`);

  await gitWorktreeAdd(repo, { branch: "feat/dirty" }, dir);
  await writeFile(join(dir, "uncommitted.txt"), "dirty\n");
  expect(await gitWorktreeDirty(dir)).toBe(true);

  await expect(gitWorktreeRemove(repo, dir)).rejects.toThrow();
  expect(await gitWorktreeExists(dir)).toBe(true);

  await gitWorktreeRemove(repo, dir, true);
  expect(await gitWorktreeExists(dir)).toBe(false);
});
