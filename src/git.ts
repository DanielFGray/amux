/**
 * Branch and ahead/behind for a space's directory.
 *
 * Shelling out to git is the only sane option here — reimplementing ref
 * resolution buys nothing — but it must never touch the render path, so every
 * call is async and the sidebar reads whatever the last refresh stored.
 */

export interface GitInfo {
  branch: string
  ahead: number
  behind: number
}

const EMPTY: GitInfo = { branch: "", ahead: 0, behind: 0 }

export async function readGit(dir: string): Promise<GitInfo> {
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)
    if (!branch) return EMPTY
    // A detached HEAD has no upstream and no meaningful name; show the short sha.
    if (branch === "HEAD") {
      const sha = await git(["rev-parse", "--short", "HEAD"], dir)
      return { branch: sha ? `(${sha})` : "(detached)", ahead: 0, behind: 0 }
    }
    // Fails when there is no upstream configured, which is normal, not an error.
    const counts = await git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], dir)
    const [behind = "0", ahead = "0"] = counts.trim().split(/\s+/)
    return { branch, ahead: Number(ahead) || 0, behind: Number(behind) || 0 }
  } catch {
    return EMPTY
  }
}

/** git now throws on failure so callers can distinguish "no output" from
 *  "git errored" — readGit's upstream-probe depends on that distinction. */
async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(err.trim() || `git ${args[0]} failed`)
  }
  return out.trim()
}
