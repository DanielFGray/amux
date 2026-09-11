/** @effect-diagnostics *:skip-file -- process-plugin dogfood: plain Bun + fzf TTY. */
/**
 * Floating transient pane: list amux panes via CLI, pick with fzf, focus the
 * selection. Cancel exits with no focus change; transient restores last pane.
 */

type PaneEntry = {
  id: string;
  space: string;
  window: number;
  session?: string;
  focused?: boolean;
  zoomed?: boolean;
};

function amuxArgv(binPath: string, session: string, args: string[]): string[] {
  // CLI strips --session from the command group; it must follow the verb.
  const withSession = [...args, `--session=${session}`];
  if (binPath.endsWith(".ts") || binPath.endsWith(".tsx") || binPath.endsWith(".js")) {
    return [process.execPath, binPath, ...withSession];
  }
  return [binPath, ...withSession];
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

function formatLine(pane: PaneEntry): string {
  const flags = [
    pane.focused === true ? "*" : " ",
    pane.zoomed === true ? "Z" : " ",
  ].join("");
  const session = pane.session ?? "-";
  return `${pane.id}\t${flags}\t${pane.space}:w${pane.window}\t${session}`;
}

async function main(): Promise<void> {
  const selfPane = process.env.AMUX_PANE_ID;
  const listed = await amux(["pane.list"]);
  if (listed.code !== 0) {
    console.error(listed.stderr.trim() || listed.stdout.trim() || "pane.list failed");
    process.exit(1);
  }
  const panes = JSON.parse(listed.stdout) as PaneEntry[];
  const lines = panes
    .filter((pane) => pane.id !== selfPane)
    .map(formatLine)
    .join("\n");

  if (lines.length === 0) {
    console.error("no other panes");
    process.exit(0);
  }

  const fzfBin = process.env.FZF_BIN ?? "fzf";
  const fzf = Bun.spawn(
    [
      fzfBin,
      "--delimiter=\t",
      "--with-nth=2..",
      "--prompt=pane> ",
      "--header=id  flags  home  session",
      "--height=100%",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: {
        ...process.env,
        PATH: `/home/dan/.zsh/plugins/junegunn---fzf/bin:${process.env.PATH ?? ""}`,
      },
    },
  );
  fzf.stdin.write(lines + "\n");
  fzf.stdin.end();
  const [picked, code] = await Promise.all([
    new Response(fzf.stdout).text(),
    fzf.exited,
  ]);
  if (code !== 0) process.exit(0);

  const paneId = picked.trim().split("\t")[0];
  if (paneId === undefined || paneId === "") process.exit(0);

  const selected = await amux(["pane.select", `--pane=${paneId}`]);
  if (selected.code !== 0) {
    console.error(selected.stderr.trim() || selected.stdout.trim() || "pane.select failed");
    process.exit(1);
  }
}

await main();
