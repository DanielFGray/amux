/** @effect-diagnostics *:skip-file -- process-plugin dogfood: plain Bun argv, not Effect. */
/**
 * Minimal amux port of herdr-auto-title's idea: a [[startup]] process that
 * polls the daemon and renames windows. Not a feature-complete port — no
 * transcript reading, process_info, or branch shortening — just enough to
 * dogfood AMUX_BIN_PATH + AMUX_DAEMON_SESSION + window.list/rename.
 *
 * Manual rename protection borrows herdr's poll-diff rule: a label that moved
 * to something we neither set nor would set is the user's, and we leave it.
 */

type WindowEntry = {
  space: string;
  number: number;
  name: string | null;
  focused: string | null;
};

type AgentEntry = {
  space: string;
  window: number;
  pane?: string;
  name: string;
  cmd?: string[];
  exited?: boolean;
};

type Track = {
  seen: string | null;
  applied: string | null;
  locked: boolean;
};

const POLL_MS = 500;

function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Build the amux CLI argv: `.ts` entries need Bun as the interpreter. */
export function amuxArgv(binPath: string, session: string, args: string[]): string[] {
  // CLI strips --session from the command group; it must follow the verb.
  const withSession = [...args, `--session=${session}`];
  if (binPath.endsWith(".ts") || binPath.endsWith(".tsx") || binPath.endsWith(".js")) {
    return [process.execPath, binPath, ...withSession];
  }
  return [binPath, ...withSession];
}

export function desiredTitle(window: WindowEntry, agents: readonly AgentEntry[]): string {
  const live = agents.filter(
    (agent) =>
      agent.space === window.space && agent.window === window.number && agent.exited !== true,
  );
  const focused =
    window.focused !== null
      ? live.find((agent) => agent.pane === window.focused)
      : undefined;
  const agent = focused ?? live[0];
  if (agent === undefined) return String(window.number);
  const fromCmd = agent.cmd?.[0] !== undefined ? basename(agent.cmd[0]) : null;
  const label = agent.name.trim() || fromCmd || "shell";
  return `${window.number} · ${label}`;
}

async function amux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = process.env.AMUX_BIN_PATH;
  const session = process.env.AMUX_DAEMON_SESSION;
  if (bin === undefined || session === undefined) {
    throw new Error("AMUX_BIN_PATH and AMUX_DAEMON_SESSION are required");
  }
  const child = Bun.spawn(amuxArgv(bin, session, args), {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function amuxJson<T>(args: string[]): Promise<T> {
  const { code, stdout, stderr } = await amux(args);
  if (code !== 0) {
    throw new Error(`amux ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return JSON.parse(stdout) as T;
}

async function renameWindow(space: string, window: number, name: string): Promise<void> {
  const { code, stdout, stderr } = await amux([
    "window.rename",
    `--space=${space}`,
    `--window=${String(window)}`,
    `--name=${name}`,
  ]);
  if (code !== 0) {
    throw new Error(`window.rename failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
}

function keyOf(window: WindowEntry): string {
  return `${window.space}:${window.number}`;
}

async function poll(tracks: Map<string, Track>, firstPoll: boolean): Promise<void> {
  const [windows, agents] = await Promise.all([
    amuxJson<WindowEntry[]>(["window.list"]),
    amuxJson<AgentEntry[]>(["agent.list"]),
  ]);
  const live = new Set(windows.map(keyOf));
  for (const key of [...tracks.keys()]) {
    if (!live.has(key)) tracks.delete(key);
  }

  for (const window of windows) {
    const key = keyOf(window);
    const desired = desiredTitle(window, agents);
    let track = tracks.get(key);
    if (track === undefined) {
      track = { seen: window.name, applied: null, locked: false };
      tracks.set(key, track);
      // First poll never locks — almost every window starts with a label that
      // is not yet desired (herdr Manual Rename Protection).
      if (!firstPoll && window.name !== null && window.name !== desired) {
        track.locked = true;
      }
    } else if (
      !track.locked &&
      window.name !== track.seen &&
      window.name !== track.applied &&
      window.name !== desired
    ) {
      track.locked = true;
    }

    track.seen = window.name;
    if (track.locked || window.name === desired) continue;
    await renameWindow(window.space, window.number, desired);
    track.applied = desired;
    track.seen = desired;
  }
}

async function main(): Promise<void> {
  if (process.env.AMUX_PLUGIN_EVENT !== "startup") {
    console.error("amux-auto-title: expected AMUX_PLUGIN_EVENT=startup");
  }
  const tracks = new Map<string, Track>();
  let first = true;
  for (;;) {
    try {
      await poll(tracks, first);
      first = false;
    } catch (error) {
      // Daemon may be briefly unreachable during restore; keep looping.
      console.error(`amux-auto-title: ${String(error)}`);
    }
    await Bun.sleep(POLL_MS);
  }
}

if (import.meta.main) {
  await main();
}
