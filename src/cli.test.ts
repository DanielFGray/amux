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

test("commands use the pane session unless an explicit session is supplied", () => {
  const previous = process.env.AMUX_DAEMON_SESSION;
  process.env.AMUX_DAEMON_SESSION = "pane-session";
  try {
    expect(resolveCommandSession("session", undefined, { title: "t", body: "b" })).toBe(
      "pane-session",
    );
    expect(
      resolveCommandSession("session", undefined, {
        title: "t",
        body: "b",
        session: "override",
      }),
    ).toBe("override");
    expect(resolveCommandSession("workspace", undefined, {})).toBe("pane-session");
  } finally {
    if (previous === undefined) delete process.env.AMUX_DAEMON_SESSION;
    else process.env.AMUX_DAEMON_SESSION = previous;
  }
});

test("ordinary commands retain the default session outside a managed pane", () => {
  const previous = process.env.AMUX_DAEMON_SESSION;
  delete process.env.AMUX_DAEMON_SESSION;
  try {
    expect(resolveCommandSession("workspace", undefined, {})).toBe("default");
    expect(resolveCommandSession("session", undefined, { title: "t", body: "b" })).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.AMUX_DAEMON_SESSION;
    else process.env.AMUX_DAEMON_SESSION = previous;
  }
});

test("session-required commands report missing pane identity from the CLI", () => {
  const { AMUX_DAEMON_SESSION: _session, ...env } = process.env;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "src/cli.ts", "notify", "--title=t", "--body=b"],
    env,
  });
  expect(result.exitCode).toBe(2);
  expect(Buffer.from(result.stderr).toString()).toContain(
    "'notify' requires a session id or a managed pane",
  );
});

test("skill output teaches managed discovery and safety", () => {
  const result = Bun.spawnSync([process.execPath, "src/cli.ts", "--skill"]);
  const stdout = Buffer.from(result.stdout).toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("name: amux");
  expect(stdout).toContain('test -n "${AMUX_DAEMON_SESSION:-}"');
  expect(stdout).toContain("amux agents");
  expect(stdout).toContain("Do not close spaces, windows, panes, or sessions");
});

test("skill output documents the delegate loop against the real contract", () => {
  const result = Bun.spawnSync([process.execPath, "src/cli.ts", "--skill"]);
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
  const result = Bun.spawnSync([process.execPath, "src/cli.ts", "agents"]);
  const stdout = Buffer.from(result.stdout).toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("usage: amux agents <command>");
  expect(stdout).toContain("agent.new");
  expect(stdout).toContain("agent.prompt");
});

test("--help prints the derived help, not a stale static copy", async () => {
  const { generateHelp } = await import("./command-cli.ts");
  const result = Bun.spawnSync([process.execPath, "src/cli.ts", "--help"]);
  const stdout = Buffer.from(result.stdout).toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toBe(generateHelp() + "\n");
});
