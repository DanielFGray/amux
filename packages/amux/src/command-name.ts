const executableName = (token: string): string =>
  token
    .split("/")
    .pop()!
    .replace(/\.(exe|cmd|js|mjs|ts)$/i, "")
    .toLowerCase();

/**
 * A readable name for whatever a pane was launched as: "zsh", "claude", "nvim".
 *
 * Every pane used to be labelled "shell" until its child got round to setting an
 * OSC title, which said nothing — the interesting part is *which* shell, and the
 * command line already carries it. Login shells arrive as argv[0] "-zsh", so the
 * conventional leading dash is stripped.
 */
export function commandName(cmd: readonly string[]): string {
  const first = cmd[0]?.trim();
  if (!first) return "shell";
  return executableName(first.replace(/^-/, "")) || "shell";
}
