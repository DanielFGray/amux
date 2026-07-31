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
    const branch = await run(dir, ["rev-parse", "--abbrev-ref", "HEAD"])
    if (!branch) return EMPTY
    // A detached HEAD has no upstream and no meaningful name; show the short sha.
    if (branch === "HEAD") {
      const sha = await run(dir, ["rev-parse", "--short", "HEAD"])
      return { branch: sha ? `(${sha})` : "(detached)", ahead: 0, behind: 0 }
    }
    // Fails when there is no upstream configured, which is normal, not an error.
    const counts = await run(dir, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
    const [behind = "0", ahead = "0"] = counts.split(/\s+/)
    return { branch, ahead: Number(ahead) || 0, behind: Number(behind) || 0 }
  } catch {
    return EMPTY
  }
}

async function run(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) return ""
  return out.trim()
}
