import { test, expect } from "bun:test";
import { spawnPty, readPty, type Pty } from "./pty.ts";
import { waitFor } from "./test-wait.ts";

const fs = require("node:fs");

/** PIDs of every process in a session — mirrors pty.ts's sessionPids. */
function sessionPids(session: number): number[] {
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[3]) === session) pids.push(Number(entry));
    } catch {}
  }
  return pids;
}

/** Iterate a pty's pump in the background and collect everything it yields. */
function collect(p: Pty): { text: () => string; done: Promise<void> } {
  const chunks: Uint8Array[] = [];
  const done = (async () => {
    for await (const c of readPty(p)) chunks.push(new Uint8Array(c));
  })();
  return { text: () => new TextDecoder().decode(Buffer.concat(chunks)), done };
}

test("input round-trips through the pty", async () => {
  const p = spawnPty(["cat"], { cols: 80, rows: 24 });
  const out = collect(p);
  p.write("hello-pty\n");
  await waitFor(() => out.text().includes("hello-pty"), "the pty to echo its input");
  await p.kill();
  await out.done;
  expect(p.closed).toBe(true);
});

test("forkpty child owns the controlling terminal session", async () => {
  const p = spawnPty(
    ["sh", "-c", 'printf \'%s %s %s\\n\' "$$" "$(ps -o sid= -p $$)" "$(ps -o tpgid= -p $$)"'],
    {
      cols: 80,
      rows: 24,
    },
  );
  const out = collect(p);
  await out.done;
  const [child, sid, foreground] = out.text().trim().split(/\s+/).map(Number);
  expect(child).toBe(p.pid);
  expect(sid).toBe(p.pid);
  expect(foreground).toBe(p.pid);
  expect(p.sessionId()).toBe(p.pid);
});

test("native exec preserves argv, cwd, environment and exit status", async () => {
  const p = spawnPty(
    ["sh", "-c", 'printf \'%s|%s|%s\\n\' "$1" "$OH_PTY_TEST" "$PWD"; exit 7', "sh", "two words"],
    { cols: 80, rows: 24, cwd: "/tmp", env: { OH_PTY_TEST: "native env" } },
  );
  const out = collect(p);
  await p.processExited;
  await out.done;
  expect(out.text()).toContain("two words|native env|/tmp");
  expect(p.exitCode).toBe(7);
});

test("environment variables override process.env and inherit unset values", async () => {
  const originalPath = process.env.PATH;
  const p = spawnPty(["/bin/sh", "-c", 'printf \'%s\\n%s\\n\' "$PATH" "$OH_INHERITED"'], {
    cols: 80,
    rows: 24,
    env: { PATH: "/custom/path", OH_INHERITED: "inherited" },
  });
  const out = collect(p);
  await p.processExited;
  await out.done;
  expect(out.text()).toContain("/custom/path");
  expect(out.text()).toContain("inherited");
  expect(out.text()).not.toContain(originalPath!);
});

test("TERM is forced to xterm-256color regardless of caller environment", async () => {
  const originalTerm = process.env.TERM;
  process.env.TERM = "dumb";
  try {
    const p = spawnPty(["sh", "-c", "printf '%s\\n' \"$TERM\""], {
      cols: 80,
      rows: 24,
    });
    const out = collect(p);
    await p.processExited;
    await out.done;
    expect(out.text()).toContain("xterm-256color");
    expect(out.text()).not.toContain("dumb");
  } finally {
    if (originalTerm !== undefined) process.env.TERM = originalTerm;
  }
});

test("environment with NUL bytes is refused", async () => {
  expect(() => spawnPty(["sh"], { cols: 80, rows: 24, env: { BAD: "value\0with\0nuls" } })).toThrow(
    /NUL/,
  );
});

test("close() is idempotent and stops the pump", async () => {
  const p = spawnPty(["cat"], { cols: 80, rows: 24 });
  const out = collect(p);
  p.close();
  p.close();
  await p.kill(); // must not throw on an already-closed master
  await out.done;
  expect(p.closed).toBe(true);
});

test("kill terminates the whole session, background jobs included", async () => {
  const p = spawnPty(["sh", "-c", "sleep 30 & sleep 30"], {
    cols: 80,
    rows: 24,
  });
  await waitFor(() => p.sessionId() > 0, "the pty session");
  const session = p.sessionId();
  // shell + bg + fg sleeps
  await waitFor(() => sessionPids(session).length >= 3, "all three session processes");
  await p.kill();
  await waitFor(() => sessionPids(session).length === 0, "the session to empty");
  expect(p.closed).toBe(true);
});

test("kill escalates a session whose children trap HUP and TERM", async () => {
  const p = spawnPty(
    ["bash", "-c", "trap '' HUP TERM; (trap '' HUP TERM; printf CHILD_READY\\n; sleep 30) & wait"],
    { cols: 80, rows: 24 },
  );
  const out = collect(p);
  await waitFor(() => p.sessionId() > 0, "the pty session");
  const session = p.sessionId();
  await waitFor(() => sessionPids(session).length >= 2, "the shell and its child");
  await waitFor(() => out.text().includes("CHILD_READY"), "the child to announce itself");

  const started = Date.now();
  await p.kill();
  await out.done;

  expect(Date.now() - started).toBeLessThan(2_000);
  expect(sessionPids(session)).toHaveLength(0);
  expect(p.closed).toBe(true);
});

test("kill drains output written by a termination trap before closing", async () => {
  const p = spawnPty(
    [
      "bash",
      "-c",
      "trap 'printf DYING_OUTPUT\\n' TERM; printf READY\\n; while :; do sleep 30; done",
    ],
    { cols: 80, rows: 24 },
  );
  const out = collect(p);
  await waitFor(() => out.text().includes("READY"), "the trap to be installed");
  await p.kill();
  await out.done;
  expect(out.text()).toContain("DYING_OUTPUT");
});

test("concurrent kill callers share one terminal operation", async () => {
  const p = spawnPty(["sh", "-c", "sleep 30"], { cols: 80, rows: 24 });
  await Promise.all([p.kill(), p.kill()]);
  expect(p.closed).toBe(true);
  await p.processExited;
});

test("a dead pump never reads an fd reused by a newer pty", async () => {
  const a = spawnPty(["cat"], { cols: 80, rows: 24 });
  const outA = collect(a);
  await a.kill();
  await outA.done;
  await a.processExited; // child gone, so its slave fd is free and a.master is reusable

  const b = spawnPty(["cat"], { cols: 80, rows: 24 });
  // Assert the reuse we're guarding against actually happened, so the test
  // cannot pass vacuously on an allocator that happened to pick a new fd.
  expect(b.master).toBe(a.master);

  const outB = collect(b);
  b.write("SECRET\n");
  await waitFor(() => outB.text().includes("SECRET"), "the second pty to echo");
  await Bun.sleep(50);
  expect(outA.text()).not.toContain("SECRET");
  await b.kill();
  await outB.done;
});

test("a child that exits on its own closes the pty exactly once, after its output is drained", async () => {
  const p = spawnPty(["sh", "-c", "exit 0"], { cols: 80, rows: 24 });
  const out = collect(p);
  await out.done;
  // Reading stops as soon as the child is gone and the buffer is empty, but the
  // master deliberately outlives that moment: closing it on exit would discard
  // whatever the child printed on its way out.
  expect(p.exited).toBe(true);
  await waitFor(() => p.closed, "the master to close after the child is gone");
  expect(p.closed).toBe(true);
  // Idempotent no matter how many paths reach it.
  p.close();
  expect(p.closed).toBe(true);
});

test("output written immediately before exiting is not lost", async () => {
  const p = spawnPty(["sh", "-c", "printf 'last-words\\n'; exit 0"], {
    cols: 80,
    rows: 24,
  });
  const out = collect(p);
  await out.done;
  expect(out.text()).toContain("last-words");
});

test("output that only arrives after a delay is not mistaken for end-of-file", async () => {
  // A zero-length read at spawn means "no process holds the slave yet", not
  // "the child is done". Treating it as EOF loses everything a slow-starting
  // agent ever prints.
  const p = spawnPty(["sh", "-c", "sleep 0.3; printf 'late\\n'"], {
    cols: 80,
    rows: 24,
  });
  const out = collect(p);
  await out.done;
  expect(out.text()).toContain("late");
});

test("aborting a blocked write stops its owned retries", async () => {
  const p = spawnPty(["sh", "-c", "sleep 30"], { cols: 80, rows: 24 });
  const controller = new AbortController();
  const write = p.write("x".repeat(16 * 1024 * 1024), controller.signal);
  await Bun.sleep(25);
  controller.abort();
  const result = await Promise.race([
    write.then(
      () => "succeeded",
      (error) => String(error),
    ),
    Bun.sleep(1000).then(() => "deadline exceeded"),
  ]);
  expect(result).toContain("PtyWriteInterrupted");
  await p.kill();
  await p.processExited;
  expect(p.closed).toBe(true);
  await expect(p.write("late")).rejects.toThrow("shutdown");
});

test("writes copy input and retain FIFO ordering", async () => {
  const p = spawnPty(["cat"], { cols: 80, rows: 24 });
  const out = collect(p);
  const second = new Uint8Array([66, 66, 66]);
  const first = p.write("AAA");
  const later = p.write(second);
  second.fill(67);
  await first;
  await later;
  await waitFor(() => out.text().includes("AAABBB"), "both queued writes to land in order");
  expect(out.text()).toContain("AAABBB");
  await p.kill();
  await out.done;
});

test("draining an idle session performs no blocking reads", async () => {
  // The drain must not sleep-poll the master with blocking reads: an idle
  // session should not wake the loop at all. A spy on readSync is the direct
  // check — a read-poll would run it ~250 times a second per session.
  const realReadSync = fs.readSync;
  let readCalls = 0;
  fs.readSync = (...args: unknown[]) => {
    readCalls++;
    return realReadSync(...(args as [number, unknown, unknown, unknown, unknown]));
  };
  try {
    const p = spawnPty(["bash", "-c", "sleep 30"], { cols: 80, rows: 24 });
    const out = collect(p);
    await Bun.sleep(250);
    await p.kill();
    await out.done;
    expect(readCalls).toBe(0);
  } finally {
    fs.readSync = realReadSync;
  }
});

/** How many times a 5ms frame clock fires while a pty drains for `ms`. */
function frameFires(cmd: string[], ms = 400): Promise<number> {
  const p = spawnPty(cmd, { cols: 80, rows: 24 });
  const done = (async () => {
    for await (const _ of readPty(p)) {
    }
  })();
  let fires = 0;
  const timer = setInterval(() => fires++, 5);
  return new Promise((resolve) => {
    setTimeout(async () => {
      clearInterval(timer);
      await p.kill();
      await Promise.race([done, Bun.sleep(2_000)]);
      resolve(fires);
    }, ms);
  });
}

test("a flooding child cannot starve the event loop's frame clock", async () => {
  // Frame time must stay decoupled from output volume: a child dumping a burst
  // must not monopolize the loop the renderer shares. Comparing the idle and
  // flooded runs in the same process cancels machine load — a drain that
  // blocked the loop would collapse the ratio far below this bound.
  const idle = await frameFires(["bash", "-c", "sleep 30"]);
  const flooded = await frameFires([
    "bash",
    "-c",
    "i=0; while :; do printf 'LINE-%06d %0100d\\n' $i $i; i=$((i+1)); done",
  ]);
  expect(flooded).toBeGreaterThanOrEqual(Math.floor(idle * 0.6));
});
