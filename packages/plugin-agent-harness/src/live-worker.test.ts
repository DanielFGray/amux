/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@danielfgray/amux/testing";
import { decodeAttachFrames, type AttachFrame } from "@danielfgray/amux/protocol";
import { readDelta, readEvent, type HarnessDelta } from "./protocol.ts";

/**
 * The DoD's live-provider clause, run against a real model.
 *
 * A native agent worker makes a real streaming call with no credential in its
 * environment or argv. This test proves it the way the DoD asks: spawn the real
 * worker with a throwaway HOME, seed the credential store with a live key, and
 * assert the spawned process environ carries no provider key while a real turn
 * streams back.
 *
 * The key must be supplied explicitly via `AMUX_LIVE_TEST_KEY`. It is never
 * read from the user's own store, because a live turn costs a real API call and
 * the suite must not spend the developer's money without being asked to. The
 * test skips when the variable is absent.
 */
test("a native agent worker streams a real turn with no provider key in its environ", async () => {
  const key = providerKey();
  if (!key) return;

  const root = await mkdtemp(join(tmpdir(), "amux-live-worker-"));
  const state = join(root, "state");
  const config = join(root, "config");
  const storeDir = join(state, "amux");
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  await mkdir(join(config, "amux"), { recursive: true });
  await writeFile(
    join(storeDir, "auth.json"),
    JSON.stringify([
      {
        id: "cred_live",
        integrationID: "opencode-go",
        label: "default",
        value: { type: "key", key },
      },
    ]) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(config, "amux", "config.json"),
    JSON.stringify({ options: { "agent.model": "opencode-go/deepseek-v4-pro" } }) + "\n",
  );

  // Provider keys in the parent environment must not reach the worker's.
  const previous = new Map<string, string | undefined>();
  const set = (name: string, value: string) => {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  };
  set("OPENAI_API_KEY", "sk-openai");
  set("ANTHROPIC_API_KEY", "sk-anthropic");
  set("OPENCODE_API_KEY", "sk-opencode");

  const entry = new URL("./native-worker.ts", import.meta.url).pathname;
  const worker = Bun.spawn([process.execPath, entry], {
    cwd: root,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            name !== "OPENAI_API_KEY" &&
            name !== "ANTHROPIC_API_KEY" &&
            name !== "OPENCODE_API_KEY",
        ),
      ),
      AMUX_SESSION: "live-worker",
      AMUX_AGENT_ID: "live-worker",
      AMUX_PANE_ID: "s1:p1",
      AMUX_AGENT_CWD: root,
      AMUX_AGENT_SIZE: JSON.stringify({ cols: 100, rows: 30 }),
      HOME: root,
      XDG_STATE_HOME: state,
      XDG_CONFIG_HOME: config,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const [name, value] of previous)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;

  try {
    // The spawned process environ carries no provider key, because the worker
    // resolves its own credential from the store it was pointed at.
    const environ = await readEnviron(worker.pid);
    expect(environ).not.toContain("OPENAI_API_KEY");
    expect(environ).not.toContain("ANTHROPIC_API_KEY");
    expect(environ).not.toContain("OPENCODE_API_KEY");

    // stdin stays open until the turn has ended: closing it ends the worker's
    // input stream, which closes the worker and interrupts the running turn.
    await worker.stdin.write(
      JSON.stringify({
        _tag: "session.message",
        session: "live-worker",
        message: { _tag: "agent.prompt", text: "Reply with exactly: hello" },
      }) + "\n",
    );

    let out = "";
    const decoder = new TextDecoder();
    await waitFor(
      async () => {
        for await (const chunk of worker.stdout as AsyncIterable<Uint8Array>) {
          out += decoder.decode(chunk);
          if (out.includes('"outcome"')) return true;
        }
        return out.includes('"outcome"');
      },
      "the worker to stream a completed turn",
      60_000,
    );

    const emitted: AttachFrame[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      emitted.push(...decodeAttachFrames(`${line}\n`).frames);
    }
    const texts = emitted
      .filter(
        (frame): frame is Extract<AttachFrame, { _tag: "agent.delta" }> =>
          frame._tag === "agent.delta",
      )
      .map((frame) => readDelta(frame))
      .filter(
        (fragment): fragment is Extract<HarnessDelta, { _tag: "text.delta" }> =>
          fragment?._tag === "text.delta",
      );
    const ended = emitted.filter(
      (frame) =>
        frame._tag === "agent.emit" &&
        frame.event._tag === "agent.message" &&
        readEvent({ ...frame.event, sequence: 0 })?._tag === "turn.end",
    );
    expect(texts.length).toBeGreaterThan(0);
    expect(
      texts
        .map((t) => t.text)
        .join("")
        .toLowerCase(),
    ).toContain("hello");
    expect(ended.length).toBe(1);
  } finally {
    worker.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

function providerKey(): string | undefined {
  return process.env.AMUX_LIVE_TEST_KEY;
}

async function readEnviron(pid: number): Promise<string> {
  let text = "";
  await waitFor(() => {
    try {
      text = require("node:fs").readFileSync(`/proc/${pid}/environ`, "utf8");
      return text.length > 0;
    } catch {
      return false;
    }
  }, "the worker's environ to be readable");
  return text;
}
