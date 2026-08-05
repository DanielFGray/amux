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
 * These checks drive processes and persisted state, so they belong in the e2e
 * suite rather than the unit suite. `bun run e2e` is a thing you run before
 * landing something that changes app wiring.
 */
import { spawnPty, readPty, type Pty } from "../src/pty.ts";
import { Terminal } from "../src/ghostty.ts";
import { captureVisible } from "../src/capture.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(new URL(import.meta.url).pathname));
const KEY_GAP_MS = 50;

/** ctrl+a, the default prefix. */
export const LEADER = "\x01";

export interface App {
  /** Everything the app has drawn since launch, escape codes and all. */
  output(): string;
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
  screen(): string;
  /**
   * Type, one keystroke per write with a gap between them.
   *
   * The prefix arms a sequence and the next key completes it; a single write
   * can arrive as one input event, which reads as neither.
   */
  press(keys: string): Promise<void>;
  /**
   * Write raw bytes straight to the app in a single write.
   *
   * A multi-byte key (an arrow, a modified key) must arrive in one chunk or the
   * streaming parser splits it on the escape timeout. `press` writes one
   * character per write for the prefix's sake, which is exactly the wrong thing
   * for `\x1b[1;5D` — so a check that needs a real ctrl+arrow builds the
   * sequence itself and sends it whole.
   */
  send(bytes: string): Promise<void>;
  /**
   * The workspace as the app last persisted it — spaces, windows and agents.
   *
   * The session file rather than the screen: a command that silently did
   * nothing is invisible in a terminal diff but obvious here, and the file is
   * the app's own account of its state rather than a rendering of it.
   */
  shape(): Promise<string>;
  /**
   * The same session file, unparsed beyond JSON — for checks that need more
   * than the shape string's counts: which window is active, or which pane a
   * window's layout says is focused.
   */
  session(): Promise<Record<string, any> | null>;
  /**
   * Poll until something is true, or fail saying what never happened.
   *
   * The alternative is a sleep long enough to cover the worst case, which is
   * both slower than it needs to be and still wrong under load — boot was
   * `Bun.sleep(3500)` and it raced the app's first save.
   */
  until(
    predicate: () => boolean | Promise<boolean>,
    what: string,
    timeoutMs?: number,
  ): Promise<void>;
  /** The config as the app last wrote it, or null if it never has. */
  config(): Promise<Record<string, any> | null>;
  stop(): Promise<void>;
}

export async function launch(
  session: string,
  opts: {
    cols?: number;
    rows?: number;
    /** Written before launch, so a check can start from a config rather than
     *  having to reach one through the settings window. */
    config?: unknown;
  } = {},
): Promise<App> {
  const home = await mkdtemp(join(tmpdir(), `amux-${session}-`));
  const state = join(home, "state");
  const configPath = join(home, "config", "amux", "config.json");
  if (opts.config !== undefined)
    await Bun.write(configPath, JSON.stringify(opts.config, null, 2) + "\n");
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
    AMUX_SESSION: session,
    TERM: "xterm-256color",
  };
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 30;
  const pty = spawnPty(["bun", join(REPO, "src/main.tsx")], { cols, rows, cwd: REPO, env });
  let out = "";
  const term = new Terminal(cols, rows);
  const reader = (async () => {
    for await (const chunk of readPty(pty)) {
      out += Buffer.from(chunk).toString("utf8");
      term.write(chunk);
    }
  })();

  // THE session file, not "whichever json turns up first".
  //
  // This used to glob `**/*.json` and take the first one with a `spaces` key,
  // and the directory holds `session.json.prev` as well — the backup, which
  // right after boot still holds the empty workspace of the very first write.
  // Glob order is filesystem order, so a check read either the live file or a
  // stale snapshot depending on the day, and `e2e/boot.ts` failed its second
  // launch as "0sp 0win 0ag" perhaps one run in two. Name the file.
  const sessionFile = join(state, "amux", "sessions", session, "session.json");

  async function readSession(): Promise<Record<string, any> | null> {
    return await Bun.file(sessionFile)
      .json()
      .catch(() => null);
  }

  async function shape(): Promise<string> {
    const saved = await readSession();
    if (!saved?.spaces) return "(no session file)";
    const windows = saved.spaces.flatMap((s: { windows: unknown[] }) => s.windows);
    const agents = windows.flatMap((w: { agents: unknown[] }) => w.agents);
    return `${saved.spaces.length}sp ${windows.length}win ${agents.length}ag`;
  }

  async function until(
    predicate: () => boolean | Promise<boolean>,
    what: string,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await Bun.sleep(100);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
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
  //
  // Boot wait must clean up on failure: a timeout throws out of launch() past
  // the App object and its stop(), leaving a live PTY, detached daemon and
  // /tmp/amux-* dir. Extract stop()'s body so both paths share it.
  const cleanup = async () => {
    await pty.kill();
    await reader.catch(() => {});
    // After the reader, never before: the pump can be holding a chunk, and a
    // write into a freed terminal corrupts ghostty's heap rather than faulting.
    term.free();
    await stopDaemon(join(state, "amux", "sessions", session, "lease.json"));
    await rm(home, { recursive: true, force: true });
  };

  try {
    await until(async () => /\s[1-9]\d*ag$/.test(await shape()), "the workspace to have an agent");
    await until(() => captureVisible(term).includes(" · "), "the sidebar to draw its footer");
  } catch (e) {
    await cleanup();
    throw e;
  }

  return {
    output: () => out,
    screen: () => captureVisible(term),
    until,
    async press(keys) {
      for (const k of keys) {
        await pty.write(k);
        // PTY writes are a byte stream, not event-framed. Leave enough time for
        // the keymap to consume one key before the next write completes a chord.
        await Bun.sleep(KEY_GAP_MS);
      }
    },
    send(bytes) {
      return pty.write(bytes);
    },
    shape,
    session: readSession,
    config: () =>
      Bun.file(configPath)
        .json()
        .catch(() => null),
    stop: cleanup,
  };
}

/** Stop the detached daemon and wait for its scoped finalizers to release its PTYs. */
async function stopDaemon(leasePath: string): Promise<void> {
  const lease = await Bun.file(leasePath)
    .json()
    .catch(() => null);
  const pid = lease?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(10);
    } catch {
      return;
    }
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* exited after the deadline */
  }
}

/** Report a list of checks and exit non-zero if any failed. */
/**
 * Per-test timeout for anything that drives the real app.
 *
 * bun's default is five seconds, which every check here would blow through on
 * the launch alone — a real app on a real PTY, spawning a real shell. It has to
 * clear `until`'s own timeout with room to spare, or a step that is merely slow
 * fails as "test timed out" and says nothing about which wait was the slow one.
 */
export const E2E_TIMEOUT = 60_000;

/**
 * The column of the tee where a divider meets the window's top frame line, or
 * -1 when no divider is drawn.
 *
 * The marker for anything that moves or removes a seam. A tee is a pure border
 * glyph, so unlike a column of spaces or a box character a shell could print,
 * it cannot be faked by whatever the child happens to have on screen.
 */
export function teeColumn(screen: string): number {
  for (const line of screen.split("\n")) {
    const at = line.indexOf("┬");
    if (at !== -1) return at;
  }
  return -1;
}

export type { Pty };
