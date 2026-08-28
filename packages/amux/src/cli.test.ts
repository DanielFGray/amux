import { expect, test } from "bun:test";
import { resolveCommandSession, splitCommandArgs } from "./cli.ts";

test("escaped shell semicolons divide command argument groups", () => {
  expect(splitCommandArgs(["pane.split", "row", ";", "pane.focus", "right"])).toEqual([
    ["pane.split", "row"],
    ["pane.focus", "right"],
  ]);
  expect(splitCommandArgs(["pane.send-keys", "hello world"])).toEqual([
    ["pane.send-keys", "hello world"],
  ]);
});

test("commands use the pane session unless --session supplies a daemon", () => {
  const previous = process.env.AMUX_DAEMON_SESSION;
  process.env.AMUX_DAEMON_SESSION = "pane-session";
  try {
    expect(resolveCommandSession("session", undefined, undefined)).toBe("pane-session");
    expect(resolveCommandSession("session", "override", undefined)).toBe("override");
    expect(resolveCommandSession("workspace", undefined, undefined)).toBe("pane-session");
  } finally {
    if (previous === undefined) delete process.env.AMUX_DAEMON_SESSION;
    else process.env.AMUX_DAEMON_SESSION = previous;
  }
});

test("ordinary commands retain the default session outside a managed pane", () => {
  const previous = process.env.AMUX_DAEMON_SESSION;
  delete process.env.AMUX_DAEMON_SESSION;
  try {
    expect(resolveCommandSession("workspace", undefined, undefined)).toBe("default");
    expect(resolveCommandSession("session", undefined, undefined)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.AMUX_DAEMON_SESSION;
    else process.env.AMUX_DAEMON_SESSION = previous;
  }
});

test("an explicit --session wins over the legacy positional session", () => {
  expect(resolveCommandSession("session", "flagged", "positional")).toBe("flagged");
  expect(resolveCommandSession("workspace", undefined, "positional")).toBe("positional");
});

test("--session is accepted by commands whose schema has no session field", () => {
  const { AMUX_DAEMON_SESSION: _session, ...env } = process.env;
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "packages/amux/src/cli.ts",
      "pane.send-keys",
      "hello",
      "--session=no-such-daemon",
    ],
    env,
  });
  // The flag selects the daemon, so the parser accepts it and the CLI only
  // fails when it cannot reach the socket — never with 'unknown flag'.
  expect(result.exitCode).toBe(1);
  expect(Buffer.from(result.stderr).toString()).not.toContain("unknown flag");
}, 20_000);

test("a malformed --session is a syntax error, not a silent default", () => {
  const { AMUX_DAEMON_SESSION: _session, ...env } = process.env;
  for (const extra of ["--session", "--session=", "--session=a --session=b"]) {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "packages/amux/src/cli.ts", "pane.zoom", ...extra.split(" ")],
      env,
    });
    expect(result.exitCode).toBe(2);
    expect(Buffer.from(result.stderr).toString()).toContain("--session");
  }
}, 20_000);

test("session-required commands report missing pane identity from the CLI", () => {
  const { AMUX_DAEMON_SESSION: _session, ...env } = process.env;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "packages/amux/src/cli.ts", "notify", "--title=t", "--body=b"],
    env,
  });
  expect(result.exitCode).toBe(2);
  expect(Buffer.from(result.stderr).toString()).toContain(
    "'notify' requires a session id or a managed pane",
  );
});

test("skill output teaches managed discovery and safety", () => {
  const result = Bun.spawnSync([process.execPath, "packages/amux/src/cli.ts", "--skill"]);
  const stdout = Buffer.from(result.stdout).toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("name: amux");
  expect(stdout).toContain('test -n "${AMUX_DAEMON_SESSION:-}"');
  expect(stdout).toContain("amux agents");
  expect(stdout).toContain("Do not close spaces, windows, panes, or sessions");
});

test("skill output documents the delegate loop against the real contract", () => {
  const result = Bun.spawnSync([process.execPath, "packages/amux/src/cli.ts", "--skill"]);
  const stdout = Buffer.from(result.stdout).toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("## Delegate work to another agent");
  expect(stdout).toContain("agent.new");
  expect(stdout).toContain("agent.prompt <target> <text>");
  expect(stdout).toContain("agent.watch <target>");
  expect(stdout).toContain("agent_prompt_stalled");
  expect(stdout).toContain("permission.request");
  expect(stdout).toContain("agent.permission");
  expect(stdout).toContain("agent.interrupt");
});

test("a bare command group prints its derived syntax", () => {
  const result = Bun.spawnSync([process.execPath, "packages/amux/src/cli.ts", "agents"]);
  const stdout = Buffer.from(result.stdout).toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("usage: amux agents <command>");
  expect(stdout).toContain("agent.new");
  expect(stdout).toContain("agent.prompt");
});

test("a typo'd flag is a syntax error (exit 2), not a refusal of a session it named", () => {
  const { AMUX_DAEMON_SESSION: _session, ...env } = process.env;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "packages/amux/src/cli.ts", "pane.close", "--bogus"],
    env,
  });
  expect(result.exitCode).toBe(2);
  expect(Buffer.from(result.stderr).toString()).toContain("unknown flag: --bogus");
});

test("--help prints the derived help, not a stale static copy", async () => {
  const { generateHelp } = await import("./command-cli.ts");
  const result = Bun.spawnSync([process.execPath, "packages/amux/src/cli.ts", "--help"]);
  const stdout = Buffer.from(result.stdout).toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toBe(generateHelp() + "\n");
});
