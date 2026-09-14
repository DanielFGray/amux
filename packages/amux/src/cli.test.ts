/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { fillCommandSession, resolveCommandSession, splitCommandArgs, stripSessionFlag } from "./cli.ts";
import { testEffect } from "./test-effect.ts";

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
    expect(resolveCommandSession("session", undefined)).toBe("pane-session");
    expect(resolveCommandSession("session", "override")).toBe("override");
    expect(resolveCommandSession("workspace", undefined)).toBe("pane-session");
  } finally {
    if (previous === undefined) delete process.env.AMUX_DAEMON_SESSION;
    else process.env.AMUX_DAEMON_SESSION = previous;
  }
});

test("ordinary commands retain the default session outside a managed pane", () => {
  const previous = process.env.AMUX_DAEMON_SESSION;
  delete process.env.AMUX_DAEMON_SESSION;
  try {
    expect(resolveCommandSession("workspace", undefined)).toBe("default");
    expect(resolveCommandSession("session", undefined)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.AMUX_DAEMON_SESSION;
    else process.env.AMUX_DAEMON_SESSION = previous;
  }
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
  expect(stripSessionFlag(["--session"])).toEqual({ error: "flag requires a value: --session" });
  expect(stripSessionFlag(["--session="])).toEqual({ error: 'invalid value for --session: ""' });
  expect(stripSessionFlag(["--session=a", "--session=b"])).toEqual({
    error: "duplicate flag: --session",
  });
  expect(stripSessionFlag(["pane.zoom", "--session=work"])).toEqual({
    rest: ["pane.zoom"],
    session: "work",
  });
});

test("fillCommandSession copies --session into a command's session field", () => {
  expect(fillCommandSession("target", {}, true)).toEqual({ session: "target" });
  expect(fillCommandSession("target", { session: "explicit" }, true)).toEqual({
    session: "explicit",
  });
  expect(fillCommandSession("target", { name: "x" }, false)).toEqual({ name: "x" });
  expect(fillCommandSession(undefined, {}, true)).toEqual({});
});

test("status and stop accept --session, not just a positional id", () => {
  const { AMUX_DAEMON_SESSION: _session, ...env } = process.env;
  for (const verb of ["status", "stop"]) {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "packages/amux/src/cli.ts", verb, "--session=no-such-daemon"],
      env,
    });
    // The flag names the daemon, so parsing succeeds; the CLI only fails
    // reaching a socket that doesn't exist — never with 'invalid session id'.
    expect(Buffer.from(result.stderr).toString()).not.toContain("invalid session id");
    expect(result.exitCode).not.toBe(2);
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
  expect(stdout).toContain("amux panes");
  expect(stdout).toContain("bun run cli --skill");
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

testEffect("--help advertises --skill the way herdr does", () =>
  Effect.gen(function* () {
    const { generateHelp } = yield* Effect.promise(() => import("./command-cli.ts"));
    const help = generateHelp();
    expect(help).toContain("--skill");
    expect(help).toContain("bun run cli --skill");
    expect(help).toContain("Are you an AI?");
  }),
);

test("a bare command group prints its derived syntax", () => {
  const result = Bun.spawnSync([process.execPath, "packages/amux/src/cli.ts", "panes"]);
  const stdout = Buffer.from(result.stdout).toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("usage: amux panes <command>");
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

test("a client launch refuses to nest inside a pane amux already owns", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "packages/amux/src/cli.ts", "new", "some-session"],
    env: { ...process.env, AMUX_DAEMON_SESSION: "outer-session" },
  });
  expect(result.exitCode).toBe(1);
  expect(Buffer.from(result.stderr).toString()).toContain("already inside amux");
  expect(Buffer.from(result.stdout).toString()).toBe("");
});

testEffect("--help prints core help plus the daemon note when no daemon answers", () =>
  Effect.gen(function* () {
    const { generateHelp, PLUGIN_COMMANDS_DAEMON_NOTE } = yield* Effect.promise(
      () => import("./command-cli.ts"),
    );
    const home = mkdtempSync(join(tmpdir(), "amux-help-no-daemon-"));
    try {
      const { AMUX_DAEMON_SESSION: _session, ...clean } = process.env;
      const env = {
        ...clean,
        HOME: home,
        XDG_STATE_HOME: join(home, "state"),
        XDG_CONFIG_HOME: join(home, "config"),
      };
      const result = Bun.spawnSync([process.execPath, "packages/amux/src/cli.ts", "--help"], {
        env,
      });
      const stdout = Buffer.from(result.stdout).toString();
      expect(result.exitCode).toBe(0);
      expect(stdout).toBe(generateHelp() + "\n\n" + PLUGIN_COMMANDS_DAEMON_NOTE + "\n");
      expect(stdout).not.toContain("editor.open");
      // Help must not start a daemon: no lease under the isolated state home.
      const stateDir = join(home, "state", "amux");
      expect(existsSync(stateDir) ? readdirSync(stateDir).length : 0).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }),
);

test("a plugin daemon tag with no daemon falls through to help with the daemon note", () => {
  const home = mkdtempSync(join(tmpdir(), "amux-no-daemon-cmd-"));
  try {
    const { AMUX_DAEMON_SESSION: _session, ...clean } = process.env;
    const env: NodeJS.ProcessEnv = {
      ...clean,
      HOME: home,
      XDG_STATE_HOME: join(home, "state"),
      XDG_CONFIG_HOME: join(home, "config"),
    };
    const result = Bun.spawnSync({
      cmd: [process.execPath, "packages/amux/src/cli.ts", "editor.open"],
      env,
    });
    const stdout = Buffer.from(result.stdout).toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Plugin commands appear when the session daemon is running.");
    expect(stdout).not.toContain("editor.open");
    const stateDir = join(home, "state", "amux");
    expect(existsSync(stateDir) ? readdirSync(stateDir).length : 0).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a later chain group names the daemon requirement when no daemon answers", () => {
  const home = mkdtempSync(join(tmpdir(), "amux-chain-no-daemon-"));
  try {
    const { AMUX_DAEMON_SESSION: _session, ...clean } = process.env;
    const env: NodeJS.ProcessEnv = {
      ...clean,
      HOME: home,
      XDG_STATE_HOME: join(home, "state"),
      XDG_CONFIG_HOME: join(home, "config"),
    };
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "packages/amux/src/cli.ts",
        "pane.focus",
        "right",
        ";",
        "editor.open",
      ],
      env,
    });
    expect(result.exitCode).toBe(2);
    expect(Buffer.from(result.stderr).toString()).toContain(
      'unknown command: "editor.open" (plugin commands need the session daemon to be running)',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
