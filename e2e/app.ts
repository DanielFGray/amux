/**
 * Driving the real app in a real PTY.
 *
 * The unit suite builds Spaces and Windows directly and never stands up
 * `createApp`, so nothing under src/ exercises the command table, the keymap or
 * the session writer — the three things a user actually touches. That gap is
 * not theoretical: ts-456094 shipped eight commands that constructed an Effect
 * and dropped it, so ^a &, ^a ! and the sidebar's kill did nothing at all, with
 * 343 green tests and a clean typecheck.
 *
 * These checks are deliberately NOT `bun test`. They spawn a process, sleep for
 * a debounce and read a file — seconds each, and flaky under load in a way a
 * unit test must never be. `bun run e2e` is a thing you run before landing
 * something that changes app wiring.
 */
import { spawnPty, readPty, type Pty } from "../src/pty.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"

const REPO = dirname(import.meta.dir)

/** ctrl+a, the default prefix. */
export const LEADER = "\x01"

export interface App {
  /** Everything the app has drawn since launch, escape codes and all. */
  output(): string
  /**
   * Type, one keystroke per write with a gap between them.
   *
   * The prefix arms a sequence and the next key completes it; a single write
   * can arrive as one input event, which reads as neither.
   */
  press(keys: string): Promise<void>
  /**
   * The workspace as the app last persisted it — spaces, windows and agents.
   *
   * The session file rather than the screen: a command that silently did
   * nothing is invisible in a terminal diff but obvious here, and the file is
   * the app's own account of its state rather than a rendering of it.
   */
  shape(): Promise<string>
  stop(): Promise<void>
}

export async function launch(session: string, opts: { cols?: number; rows?: number } = {}): Promise<App> {
  const home = await mkdtemp(join(tmpdir(), `herdr-${session}-`))
  const state = join(home, "state")
  const env = {
    ...process.env,
    // A throwaway HOME so a real session file, config or shell rc can neither
    // be read nor written by a check.
    HOME: home,
    // /bin/sh rather than the user's shell: a fresh HOME sends zsh into
    // zsh-newuser-install, which swallows the first keystrokes typed at it.
    // The check is about the mux, not about whose dotfiles are missing.
    SHELL: "/bin/sh",
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(home, "config"),
    HERDR_SESSION: session,
    TERM: "xterm-256color",
  }
  const pty = spawnPty(["bun", join(REPO, "src/main.tsx")], {
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
    cwd: REPO,
    env,
  })
  let out = ""
  const reader = (async () => {
    for await (const chunk of readPty(pty)) out += Buffer.from(chunk).toString("utf8")
  })()

  // Long enough for the renderer, the first agent's shell and the first draw.
  await Bun.sleep(3500)

  return {
    output: () => out,
    async press(keys) {
      for (const k of keys) {
        pty.write(k)
        await Bun.sleep(250)
      }
      // Past the 500ms save debounce, with room for a release to unwind: a
      // scope close interrupts the agent's pump fiber before freeing its
      // terminal, so the write that follows is not immediate.
      await Bun.sleep(1500)
    },
    async shape() {
      for await (const file of new Bun.Glob("**/*.json").scan({ cwd: state, absolute: true })) {
        const saved = await Bun.file(file).json().catch(() => null)
        if (!saved?.spaces) continue
        const windows = saved.spaces.flatMap((s: { windows: unknown[] }) => s.windows)
        const agents = windows.flatMap((w: { agents: unknown[] }) => w.agents)
        return `${saved.spaces.length}sp ${windows.length}win ${agents.length}ag`
      }
      return "(no session file)"
    },
    async stop() {
      pty.kill()
      await reader.catch(() => {})
      await rm(home, { recursive: true, force: true })
    },
  }
}

/** Report a list of checks and exit non-zero if any failed. */
export function report(checks: readonly (readonly [string, boolean])[]): never {
  console.log()
  for (const [what, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${what}`)
  const failed = checks.filter(([, ok]) => !ok).length
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

export type { Pty }
