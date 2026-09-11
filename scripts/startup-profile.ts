/**
 * End-to-end startup timer: spawn `main.tsx` on a PTY, wait until a shell
 * marker echoes back, report wall time and (when AMUX_STARTUP_PROBE=1) phase marks.
 *
 * Usage:
 *   bun scripts/startup-profile.ts              # cold daemon
 *   bun scripts/startup-profile.ts --warm       # reuse a pre-started daemon
 *   bun scripts/startup-profile.ts --runs 5
 */
import { spawnPty, readPty } from "../packages/amux/src/pty.ts";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dir, "..");
const MARKER = `AMUX-STARTUP-${process.pid}`;
const runs = Number(process.argv.find((_, i, a) => a[i - 1] === "--runs") ?? 3);
const warm = process.argv.includes("--warm");
const probe = !process.argv.includes("--no-probe");

async function stopLease(leasePath: string) {
  try {
    const lease = JSON.parse(await readFile(leasePath, "utf8")) as { pid?: number };
    if (lease.pid && lease.pid > 1) {
      try {
        process.kill(lease.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await Bun.sleep(50);
      try {
        process.kill(lease.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no lease */
  }
}

async function oneRun(label: string, session: string, keepDaemon: boolean) {
  const root = join(tmpdir(), `amux-startup-${session}`);
  const state = join(root, "state");
  const home = join(root, "home");
  const leasePath = join(state, "amux", "sessions", session, "lease.json");
  const probePath = join(root, "startup-probe.json");
  const pidFile = join(root, "daemon.pid");

  if (!keepDaemon) {
    await stopLease(leasePath);
    await rm(root, { recursive: true, force: true });
  }
  await mkdir(join(home, "config", "amux"), { recursive: true });
  await mkdir(state, { recursive: true });
  await Bun.write(
    join(home, "config", "amux", "config.json"),
    JSON.stringify({ options: {}, plugins: [] }, null, 2) + "\n",
  );

  const env: Record<string, string> = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/sh",
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(home, "config"),
    AMUX_DAEMON_PID_FILE: pidFile,
    AMUX_SESSION: session,
    TERM: "xterm-256color",
    ...(probe
      ? { AMUX_STARTUP_PROBE: "1", AMUX_STARTUP_PROBE_PATH: probePath }
      : {}),
  };

  const t0 = performance.now();
  const pty = spawnPty(
    [
      "bun",
      "--preload",
      join(REPO, "scripts/startup-preload.ts"),
      join(REPO, "packages/amux/src/main.tsx"),
    ],
    {
      cols: 100,
      rows: 30,
      cwd: REPO,
      env,
    },
  );

  let out = "";
  let markerAt: number | null = null;
  const reader = (async () => {
    for await (const chunk of readPty(pty)) {
      out += Buffer.from(chunk).toString("utf8");
      if (markerAt === null && out.includes(MARKER)) markerAt = performance.now() - t0;
    }
  })();

  // Wait until the workspace has a live agent, then type the marker.
  const sessionFile = join(state, "amux", "sessions", session, "session.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const saved = (await Bun.file(sessionFile).json()) as {
        spaces?: { windows?: { sessions?: unknown[] }[] }[];
      };
      const agents =
        saved.spaces?.flatMap((s) => s.windows ?? []).flatMap((w) => w.sessions ?? [])
          .length ?? 0;
      if (agents >= 1) break;
    } catch {
      /* not yet */
    }
    await Bun.sleep(25);
  }
  const agentReadyAt = performance.now() - t0;
  await pty.write(`echo ${MARKER}\r`);

  while (markerAt === null && Date.now() < deadline) await Bun.sleep(25);
  const interactiveMs = markerAt ?? performance.now() - t0;

  let phases: Record<string, number> | null = null;
  try {
    phases = JSON.parse(await readFile(probePath, "utf8")) as Record<string, number>;
  } catch {
    /* probe missing */
  }

  await pty.kill();
  await reader.catch(() => {});
  if (!keepDaemon) {
    await stopLease(leasePath);
    await rm(root, { recursive: true, force: true });
  }

  return { label, interactiveMs, agentReadyAt, phases, crashed: /FiberFailure|Unhandled/.test(out) };
}

const session = `startup-prof-${process.pid}`;
const results: Awaited<ReturnType<typeof oneRun>>[] = [];

if (warm) {
  // Prime daemon once, then measure client reconnects against it.
  const prime = await oneRun("prime", session, true);
  if (prime.crashed) {
    console.error("prime run crashed");
    process.exit(1);
  }
  console.log(`primed daemon in ${prime.interactiveMs.toFixed(0)}ms (cold)`);
  for (let i = 0; i < runs; i++) {
    results.push(await oneRun(`warm-${i + 1}`, session, true));
  }
  await stopLease(join(tmpdir(), `amux-startup-${session}`, "state", "amux", "sessions", session, "lease.json"));
  await rm(join(tmpdir(), `amux-startup-${session}`), { recursive: true, force: true });
} else {
  for (let i = 0; i < runs; i++) {
    results.push(await oneRun(`cold-${i + 1}`, `${session}-${i}`, false));
  }
}

for (const r of results) {
  console.log(
    `${r.label.padEnd(10)} interactive=${r.interactiveMs.toFixed(0).padStart(5)}ms  agent=${r.agentReadyAt.toFixed(0).padStart(5)}ms${r.crashed ? " CRASHED" : ""}`,
  );
  if (r.phases) {
    const entries = Object.entries(r.phases).sort((a, b) => a[1] - b[1]);
    for (const [k, v] of entries) console.log(`  ${v.toFixed(1).padStart(8)}  ${k}`);
  }
}

const ok = results.filter((r) => !r.crashed);
if (ok.length) {
  const avg = ok.reduce((s, r) => s + r.interactiveMs, 0) / ok.length;
  const min = Math.min(...ok.map((r) => r.interactiveMs));
  const max = Math.max(...ok.map((r) => r.interactiveMs));
  console.log(`\navg=${avg.toFixed(0)}ms  min=${min.toFixed(0)}ms  max=${max.toFixed(0)}ms  (n=${ok.length})`);
}
