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
import { Terminal } from "../src/ghostty.ts"
import { captureVisible } from "../src/capture.ts"
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
   * What is ON SCREEN, as plain text.
   *
   * Not `output()` filtered — `output()` is a byte stream from a *diffing*
   * renderer, and asking it what the screen says gives wrong answers with total
   * confidence. The sidebar footer reads "1 space · 1 agent", but it is emitted
   * as "1 space ·", a cursor jump, then " 1 agent", so the string is not in the
   * stream even on the very first draw; and when the count later goes to 2 the
   * renderer emits a single cell. Grepping the stream for "2 agents" therefore
   * finds nothing whether the app is right or wrong, which is how ts-9beb5d got
   * filed against a footer that was updating correctly the whole time.
   *
   * So the bytes go through the same VT the app runs its own panes on, and this
   * reads that terminal's screen. A check gets to ask what a user would see.
   */
  screen(): string
  /**
   * Type, one keystroke per write with a gap between them.
   *
   * The prefix arms a sequence and the next key completes it; a single write
   * can arrive as one input event, which reads as neither.
   */
  press(keys: string): Promise<void>
  /**
   * Write raw bytes straight to the app in a single write.
   *
   * A multi-byte key (an arrow, a modified key) must arrive in one chunk or the
   * streaming parser splits it on the escape timeout. `press` writes one
   * character per write for the prefix's sake, which is exactly the wrong thing
   * for `\x1b[1;5D` — so a check that needs a real ctrl+arrow builds the
   * sequence itself and sends it whole.
   */
  send(bytes: string): void
  /**
   * The workspace as the app last persisted it — spaces, windows and agents.
   *
   * The session file rather than the screen: a command that silently did
   * nothing is invisible in a terminal diff but obvious here, and the file is
   * the app's own account of its state rather than a rendering of it.
   */
  shape(): Promise<string>
  /**
   * Poll until something is true, or fail saying what never happened.
   *
   * The alternative is a sleep long enough to cover the worst case, which is
   * both slower than it needs to be and still wrong under load — boot was
   * `Bun.sleep(3500)` and it raced the app's first save.
   */
  until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs?: number): Promise<void>
  /** The config as the app last wrote it, or null if it never has. */
  config(): Promise<Record<string, any> | null>
  stop(): Promise<void>
}

export async function launch(
  session: string,
  opts: {
    cols?: number
    rows?: number
    /** Written before launch, so a check can start from a config rather than
     *  having to reach one through the settings window. */
    config?: unknown
  } = {},
): Promise<App> {
  const home = await mkdtemp(join(tmpdir(), `herdr-${session}-`))
  const state = join(home, "state")
  const configPath = join(home, "config", "opentui-herdr", "config.json")
  if (opts.config !== undefined) await Bun.write(configPath, JSON.stringify(opts.config, null, 2) + "\n")
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
  const cols = opts.cols ?? 100
  const rows = opts.rows ?? 30
  const pty = spawnPty(["bun", join(REPO, "src/main.tsx")], { cols, rows, cwd: REPO, env })
  let out = ""
  const term = new Terminal(cols, rows)
  const reader = (async () => {
    for await (const chunk of readPty(pty)) {
      out += Buffer.from(chunk).toString("utf8")
      term.write(chunk)
    }
  })()

  // THE session file, not "whichever json turns up first".
  //
  // This used to glob `**/*.json` and take the first one with a `spaces` key,
  // and the directory holds `session.json.prev` as well — the backup, which
  // right after boot still holds the empty workspace of the very first write.
  // Glob order is filesystem order, so a check read either the live file or a
  // stale snapshot depending on the day, and `e2e/boot.ts` failed its second
  // launch as "0sp 0win 0ag" perhaps one run in two. Name the file.
  const sessionFile = join(state, "opentui-herdr", "sessions", session, "session.json")

  async function shape(): Promise<string> {
    const saved = await Bun.file(sessionFile).json().catch(() => null)
    if (!saved?.spaces) return "(no session file)"
    const windows = saved.spaces.flatMap((s: { windows: unknown[] }) => s.windows)
    const agents = windows.flatMap((w: { agents: unknown[] }) => w.agents)
    return `${saved.spaces.length}sp ${windows.length}win ${agents.length}ag`
  }

  async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return
      await Bun.sleep(100)
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
  }

  // Booted means drawn AND saved, because checks read both. This was
  // `Bun.sleep(3500)` — long enough on an idle machine, and under load the
  // session file did not exist yet, which surfaced as a crashed harness rather
  // than as a slow boot. Wait for the thing itself.
  //
  // "Has an agent", specifically. Not "a file exists" and not "the shape isn't
  // 0sp": the app saves an empty workspace first and fills it in a moment
  // later, and before either of those `shape()` says "(no session file)" —
  // which satisfies any predicate phrased as a negation, so the wait returned
  // on its first poll and the check then read the empty write.
  await until(async () => /\s[1-9]\d*ag$/.test(await shape()), "the workspace to have an agent")
  await until(() => captureVisible(term).includes(" · "), "the sidebar to draw its footer")

  return {
    output: () => out,
    screen: () => captureVisible(term),
    until,
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
    send(bytes) {
      pty.write(bytes)
    },
    shape,
    config: () => Bun.file(configPath).json().catch(() => null),
    async stop() {
      pty.kill()
      await reader.catch(() => {})
      // After the reader, never before: the pump can be holding a chunk, and a
      // write into a freed terminal corrupts ghostty's heap rather than faulting.
      term.free()
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
