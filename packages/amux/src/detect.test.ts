import { test, expect } from "bun:test";
import { which } from "bun";
import { mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitActivity, identifyAgent } from "./detect.ts";
import { SessionHandle } from "./session-handle.ts";
import { ProcessStateAuthority } from "./process-state-arbiter.ts";
import { waitFor } from "./test-wait.ts";

test("a leading braille spinner marks the agent working and is stripped from the title", () => {
  for (const frame of ["⠋", "⠙", "⠹", "⠿"]) {
    const { spinning, text } = splitActivity(`${frame} building the thing`);
    expect(spinning).toBe(true);
    expect(text).toBe("building the thing");
  }
});

test("Claude Code's own activity glyphs count as spinners", () => {
  for (const glyph of ["·", "✢", "✳", "✶", "✻", "✽"]) {
    expect(splitActivity(`${glyph} task`)).toEqual({
      spinning: true,
      text: "task",
    });
  }
});

test("a symbol that is part of the title is left alone", () => {
  // Only a single leading glyph followed by whitespace counts, so a title that
  // legitimately opens with a symbol keeps its text and reports not-working.
  expect(splitActivity("★ production")).toEqual({
    spinning: false,
    text: "★ production",
  });
  expect(splitActivity("✨ task")).toEqual({
    spinning: false,
    text: "✨ task",
  });
  expect(splitActivity("nvim ~/src")).toEqual({
    spinning: false,
    text: "nvim ~/src",
  });
  // Two spinners: only the first is stripped, matching herdr's behaviour.
  expect(splitActivity("⠋ ⠙ task")).toEqual({ spinning: true, text: "⠙ task" });
});

test("empty and whitespace titles are not spinners", () => {
  expect(splitActivity("")).toEqual({ spinning: false, text: "" });
  expect(splitActivity("   ")).toEqual({ spinning: false, text: "" });
});

test("agent CLIs are recognised by executable name, and nothing else is", () => {
  expect(identifyAgent("claude")).toBe("claude");
  expect(identifyAgent("/home/x/.bun/bin/claude --resume")).toBe("claude");
  expect(identifyAgent("cursor-agent")).toBe("cursor");
  expect(identifyAgent("OpenCode")).toBe("opencode");
  // The things that used to light up a spinner merely by existing.
  expect(identifyAgent("nvim")).toBe(null);
  expect(identifyAgent("bash")).toBe(null);
  expect(identifyAgent("cargo build")).toBe(null);
  expect(identifyAgent("")).toBe(null);
});

/**
 * A stand-in for an agent CLI: a copy of bash under an agent's name, so a test
 * can drive what ends up on its screen.
 *
 * A copy rather than a wrapper script, because detection reads the foreground
 * process's argv — and a script that `exec`s bash leaves nothing behind with the
 * agent's name on it, which is exactly the right answer for a wrapper and the
 * wrong shape for a fixture.
 */
async function fakeAgent(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "amux-detect-"));
  const path = join(dir, name);
  const bash = which("bash");
  if (!bash) throw new Error("no bash on PATH to impersonate");
  await Bun.write(path, Bun.file(bash));
  await chmod(path, 0o755);
  return path;
}

test("a plain shell is idle whatever it is running", async () => {
  // The old behaviour reported any foreground process as "working", so opening
  // nvim in a pane put a spinner next to it. Only agents get a state now.
  using session = new SessionHandle({
    name: "t",
    cmd: ["bash", "--norc", "--noprofile"],
  });
  await waitFor(() => session.foregroundCommand === "", "the shell prompt");
  expect(session.state).toBe("idle");
  session.write("sleep 3\n");
  await waitFor(() => session.foregroundCommand === "sleep", "the foreground command");
  expect(session.state).toBe("idle");
  // Still visible as a running process — it is only the state that changed.
  expect(session.foregroundCommand).toBe("sleep");
  expect(session.agentKind).toBe(null);
});

test("a blocked prompt on an agent's screen reads as blocked", async () => {
  using session = new SessionHandle({
    name: "t",
    cmd: [await fakeAgent("claude"), "--norc", "--noprofile"],
  });
  await waitFor(() => session.agentKind === "claude", "the agent process");
  expect(session.agentKind).toBe("claude");
  session.write("printf 'Do you want to proceed?\\n'\n");
  await waitFor(() => session.state === "blocked", "the blocked prompt");
  expect(session.state).toBe("blocked");
  expect(session.screenRegion("bottom_lines(20)")).toContain("Do you want to proceed?");
});

test("a harness state source overrides a screen heuristic on its pane", async () => {
  const claude = await fakeAgent("claude");
  using session = new SessionHandle({ name: "t", cmd: [claude, "--norc", "--noprofile"] });
  session.write("printf 'Do you want to proceed?\\n'\n");
  await waitFor(() => session.state === "blocked", "the blocked prompt");
  session.registerStateSource({ authority: ProcessStateAuthority.Harness, state: () => "running" });
  expect(session.state).toBe("running");
});

test("detection runs while state sources or readers are registered", async () => {
  using session = new SessionHandle({ name: "t", cmd: ["bash", "--norc", "--noprofile"] });
  let sourceReads = 0;
  let readerReads = 0;
  const removeSource = session.registerStateSource({
    authority: ProcessStateAuthority.Harness,
    state: () => {
      sourceReads++;
      return "unknown";
    },
  });

  await waitFor(() => sourceReads > 0, "the source detection loop");
  const removeReader = session.registerStateReader(() => {
    readerReads++;
  });
  await waitFor(() => readerReads > 0, "the state reader");

  removeSource();
  const readsBeforeLastWithdrawal = readerReads;
  await waitFor(() => readerReads > readsBeforeLastWithdrawal, "the remaining reader");

  removeReader();
  const readsAfterLastWithdrawal = readerReads;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(readerReads).toBe(readsAfterLastWithdrawal);
});

test("an agent started from a shell is picked up from the foreground process", async () => {
  const claude = await fakeAgent("claude");
  using session = new SessionHandle({
    name: "t",
    cmd: ["bash", "--norc", "--noprofile"],
  });
  await waitFor(() => session.foregroundCommand === "", "the shell prompt");
  expect(session.agentKind).toBe(null);
  session.write(`${claude} --norc --noprofile\n`);
  await waitFor(() => session.agentKind === "claude", "the foreground agent");
  expect(session.agentKind).toBe("claude");
});

test("an exited agent is done regardless of what is left on screen", async () => {
  using session = new SessionHandle({
    name: "t",
    cmd: ["sh", "-c", "printf 'Press enter to continue\\n'"],
  });
  await waitFor(() => session.exited, "the process to exit");
  expect(session.state).toBe("done");
});
