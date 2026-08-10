import { expect, test } from "bun:test";
import { resolveCommandSession } from "./cli.ts";

test("commands use the pane session unless an explicit session is supplied", () => {
  const previous = process.env.AMUX_DAEMON_SESSION;
  process.env.AMUX_DAEMON_SESSION = "pane-session";
  try {
    expect(resolveCommandSession("notify", undefined, { title: "t", body: "b" })).toBe(
      "pane-session",
    );
    expect(
      resolveCommandSession("notify", undefined, { title: "t", body: "b", session: "override" }),
    ).toBe("override");
    expect(resolveCommandSession("pane.next", undefined, {})).toBe("pane-session");
  } finally {
    if (previous === undefined) delete process.env.AMUX_DAEMON_SESSION;
    else process.env.AMUX_DAEMON_SESSION = previous;
  }
});

test("ordinary commands retain the default session outside a managed pane", () => {
  const previous = process.env.AMUX_DAEMON_SESSION;
  delete process.env.AMUX_DAEMON_SESSION;
  try {
    expect(resolveCommandSession("pane.next", undefined, {})).toBe("default");
    expect(resolveCommandSession("notify", undefined, { title: "t", body: "b" })).toBeNull();
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
