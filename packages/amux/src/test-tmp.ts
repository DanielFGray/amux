/**
 * A shared home for test-owned scratch directories under the OS tmpdir.
 *
 * Every test file that needs an isolated home/state directory used to mkdtemp
 * its own, track it in a local array, and rm it in its own afterEach. That
 * works for a test that finishes normally, but a killed run (a timeout, a
 * crash, Ctrl-C during dev) skips afterEach entirely — and on a tmpfs /tmp
 * every leaked directory is RAM, not disk, that never comes back until reboot.
 *
 * Two pieces fix that instead of adding a 22nd copy of the same afterEach:
 * `tempDir` names what it makes with the owning pid, and `sweepStaleDirs`
 * reclaims anything a dead pid left behind — a crashed process cannot clean up
 * after itself, so the next run does it instead.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const PID_NAME = /^amux-tmp-(\d+)-/;

/** How long a directory with no pid to check (a name from before this fixture
 *  existed, or a caller-chosen fixed name) is left alone before it counts as
 *  stale. Long enough that no run in progress could plausibly still want it. */
const LEGACY_STALE_MS = 6 * 60 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process, safe to reclaim. EPERM: it exists and belongs to
    // someone else, which this process has no business judging — leave it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove leftover `amux-*` directories a prior run could not clean up itself.
 *
 * Exported and taking a root so it is directly testable; every real caller
 * goes through the import-time sweep below instead of naming a root itself.
 */
export function sweepStaleDirs(root: string = tmpdir()): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith("amux-")) continue;
    const path = join(root, name);
    const pidMatch = PID_NAME.exec(name);
    if (pidMatch) {
      if (!isPidAlive(Number(pidMatch[1]))) rmSync(path, { recursive: true, force: true });
      continue;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > LEGACY_STALE_MS)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // Removed by a concurrent sweep, or by the run that owned it. Nothing to do.
    }
  }
}

let swept = false;

/**
 * Idempotent: the first `tempDir` call in a process schedules one sweep, so
 * importing this module outside the test runner (this file's own tests, for
 * one) never triggers it on its own.
 *
 * Scheduled rather than run inline: a run with hundreds of accumulated stale
 * directories can mean hundreds of megabytes to remove, and `rmSync` blocks
 * the event loop for the whole recursive delete. Doing that synchronously on
 * the first `tempDir` call once stalled a live daemon test hard enough to
 * miss its own timeout. A moment on the event loop's next turn costs nothing
 * a test relies on, since nothing depends on stale directories being gone by
 * any particular point — only that they eventually are.
 */
function ensureSwept(): void {
  if (swept) return;
  swept = true;
  setTimeout(() => sweepStaleDirs(), 0);
}

const owned: string[] = [];

/**
 * Make a directory this test file owns.
 *
 * Named with the owning pid so a dead run's leftovers are unambiguous to a
 * later sweep, and with `label` so a directory found on disk mid-debugging
 * says which suite left it.
 */
export function tempDir(label: string, base: string = tmpdir()): string {
  ensureSwept();
  const dir = mkdtempSync(join(base, `amux-tmp-${process.pid}-${label}-`));
  owned.push(dir);
  return dir;
}

/**
 * Remove every directory `tempDir` made in this file, once every `afterEach`
 * in the file has run. Call once per test file, at module scope.
 *
 * Not `afterEach`: some of these homes belong to a daemon whose own teardown
 * writes state back to disk during its `afterEach`, which would recreate an
 * already-removed directory out from under it. bun:test runs `afterEach`
 * hooks in registration order and `afterAll` only once every `afterEach` in
 * the file is done, so that is the first point removal is safe.
 *
 * This module is imported once and shared by every test file in the process,
 * so its own top-level state cannot tell one file's registration from
 * another's — but `afterAll` itself is scoped to whichever file is loading
 * when it is called, which is why each file has to call this itself rather
 * than the shared module doing it once on their behalf.
 */
export function registerCleanup(): void {
  afterAll(() => {
    for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
}
