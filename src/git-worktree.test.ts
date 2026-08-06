import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { Session, SessionEnv } from "./session.ts";
import { Command, command } from "./commands.ts";
import {
  gitWorktreeAdd,
  gitWorktreeDirty,
  gitWorktreeExists,
  gitWorktreeRemove,
  worktreeDirname,
} from "./git.ts";
import type { WorkspaceCommandContext } from "./workspace.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function env() {
  const home = await mkdtemp(join(tmpdir(), "amux-wt-"));
  dirs.push(home);
  return { HOME: home, XDG_STATE_HOME: join(home, "state") };
}

const run = <A>(
  effect: Effect.Effect<A, unknown, SessionEnv | Session | FileSystem.FileSystem>,
  e: NodeJS.ProcessEnv,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Session.Default),
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(SessionEnv, e),
    ),
  );
const open = (id: string, e: NodeJS.ProcessEnv) => run(Effect.scoped(startDaemon(id)), e);
const ws = (d: SessionDaemonService) => Effect.runSync(d.getWorkspace);
const close = (d: SessionDaemonService) => Effect.runPromise(d.close);
const runCommand = (
  d: SessionDaemonService,
  value: Command,
  revision: number,
  context: WorkspaceCommandContext,
) => Effect.runPromise(d.runWorkspaceCommand(value, revision, context));

const git = async (args: string[], cwd: string): Promise<string> => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
  return out.trim();
};

/** A scratch repository with one initial commit, so worktrees have a base. */
async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "amux-repo-"));
  dirs.push(repo);
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "t@t.org"], repo);
  await git(["config", "user.name", "T"], repo);
  await writeFile(join(repo, "readme.md"), "groceries\n");
  await git(["add", "readme.md"], repo);
  await git(["commit", "-m", "groceries"], repo);
  return repo;
}

test("gitWorktreeAdd creates a branch and worktree; remove tears it down", async () => {
  const repo = await initRepo();
  const root = join(repo, "..", "wt-root");
  await mkdir(root);
  dirs.push(root);
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

  const root = join(repo, "..", "wt-root");
  await mkdir(root);
  dirs.push(root);
  const dir = join(root, `abc-${worktreeDirname("feat/from-base")}`);

  await gitWorktreeAdd(repo, { branch: "feat/from-base", base: "base" }, dir);
  expect(await Bun.file(join(dir, "extra.txt")).exists()).toBe(true);
  expect(await Bun.file(join(dir, "readme.md")).exists()).toBe(true);
  // Branched from 'base', not from the repo's HEAD ('main', no extra.txt).
  expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).toBe("feat/from-base");
  expect(await git(["status", "--porcelain"], dir)).toBe("");
});

test("gitWorktreeRemove refuses a dirty worktree unless forced", async () => {
  const repo = await initRepo();
  const root = join(repo, "..", "wt-root");
  await mkdir(root);
  dirs.push(root);
  const dir = join(root, `abc-${worktreeDirname("feat/dirty")}`);

  await gitWorktreeAdd(repo, { branch: "feat/dirty" }, dir);
  await writeFile(join(dir, "uncommitted.txt"), "dirty\n");
  expect(await gitWorktreeDirty(dir)).toBe(true);

  await expect(gitWorktreeRemove(repo, dir)).rejects.toThrow();
  expect(await gitWorktreeExists(dir)).toBe(true);

  await gitWorktreeRemove(repo, dir, true);
  expect(await gitWorktreeExists(dir)).toBe(false);
});

test("space.new with a branch creates a worktree under the daemon's worktrees root", async () => {
  const repo = await initRepo();
  const e = await env();
  const daemon = await open("wt-new", e);
  try {
    const worktreesRoot = join(e.HOME!, "wt");
    await mkdir(worktreesRoot);
    const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp", worktreesRoot };
    const before = ws(daemon).revision;
    await runCommand(
      daemon,
      command("space.new", { branch: "feat/demo", dir: repo, base: "main" }),
      before,
      context,
    );
    const space = ws(daemon).spaces.find((s) => s.worktree?.branch === "feat/demo");
    expect(space).toBeDefined();
    const worktree = space!.worktree!;
    expect(worktree.repo).toBe(repo);
    // The client's worktreesRoot is advisory: the daemon resolves the real root
    // from its own env (XDG_STATE_HOME), never from a client-supplied path.
    expect(worktree.path).toBe(
      join(e.XDG_STATE_HOME!, "amux", "worktrees", `${space!.id}-${worktreeDirname("feat/demo")}`),
    );
    expect(await gitWorktreeExists(worktree.path)).toBe(true);
  } finally {
    await close(daemon);
  }
});

test("space.close removes the space's worktree after the model commit", async () => {
  const repo = await initRepo();
  const e = await env();
  const daemon = await open("wt-close", e);
  const worktreesRoot = join(e.HOME!, "wt");
  await mkdir(worktreesRoot);
  const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp", worktreesRoot };

  await runCommand(
    daemon,
    command("space.new", { branch: "feat/close", dir: repo }),
    ws(daemon).revision,
    context,
  );
  const space = ws(daemon).spaces.find((s) => s.worktree?.branch === "feat/close")!;
  const worktreePath = space.worktree!.path;
  expect(await gitWorktreeExists(worktreePath)).toBe(true);

  await runCommand(
    daemon,
    command("space.close", { space: space.id }),
    ws(daemon).revision,
    context,
  );
  expect(ws(daemon).spaces.find((s) => s.id === space.id)).toBeUndefined();
  expect(await gitWorktreeExists(worktreePath)).toBe(false);
  await close(daemon);
});

test("a dirty worktree rejects space.close without losing model or worktree", async () => {
  const repo = await initRepo();
  const e = await env();
  const daemon = await open("wt-dirty-close", e);
  const worktreesRoot = join(e.HOME!, "wt");
  await mkdir(worktreesRoot);
  const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp", worktreesRoot };

  await runCommand(
    daemon,
    command("space.new", { branch: "feat/keep", dir: repo }),
    ws(daemon).revision,
    context,
  );
  const space = ws(daemon).spaces.find((s) => s.worktree?.branch === "feat/keep")!;
  await writeFile(join(space.worktree!.path, "pending.txt"), "wip\n");

  await expect(
    runCommand(daemon, command("space.close", { space: space.id }), ws(daemon).revision, context),
  ).rejects.toThrow(/uncommitted changes/);
  // The failed close is a no-op: the space and its worktree both survive.
  expect(ws(daemon).spaces.find((s) => s.id === space.id)).toBeDefined();
  expect(await gitWorktreeExists(space.worktree!.path)).toBe(true);
  await close(daemon);
});

test("a failed space.new leaves no worktree behind", async () => {
  const repo = await initRepo();
  const e = await env();
  const daemon = await open("wt-failed-new", e);
  const worktreesRoot = join(e.HOME!, "wt");
  await mkdir(worktreesRoot);
  const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp", worktreesRoot };

  const revision = ws(daemon).revision;
  // Branch already exists in the repo: git worktree add -b must fail, which
  // aborts the transaction before the space is committed.
  await git(["branch", "taken"], repo);
  await expect(
    runCommand(daemon, command("space.new", { branch: "taken", dir: repo }), revision, context),
  ).rejects.toThrow();

  const orphan = join(worktreesRoot, `${"anything"}-${worktreeDirname("taken")}`);
  expect(await gitWorktreeExists(orphan)).toBe(false);
  const spaces = await readFile(
    join(e.XDG_STATE_HOME!, "amux", "sessions", "wt-failed-new", "session.json"),
    "utf8",
  );
  expect(spaces).not.toContain("feat/taken");
  await close(daemon);
});
