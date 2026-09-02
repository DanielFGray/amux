/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/**
 * The app boots, draws, and runs a shell.
 *
 * The check the Effect-migration tasks call "the real-TUI boot check". It is
 * deliberately shallow — it presses almost nothing — because its job is to
 * catch the failures that make everything else moot: a service that cannot be
 * acquired, a scope that closes on the way up, a renderer that never draws.
 * ts-95af71's Definition of Done is the reason it exists.
 */
import { test, expect, beforeAll } from "bun:test";
import { launch, E2E_TIMEOUT } from "./app.ts";

const MARKER = "MARKER-ONE";

/** Anything the runtime prints when it gives up. Escape codes are stripped
 *  first: a crash report is plain text, and the screen around it is not. */
function crashed(out: string): string | null {
  // Stripping ANSI sequences means matching the ESC control character on purpose.
  // eslint-disable-next-line eslint/no-control-regex
  const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const hit = plain.match(
    /(FiberFailure|Unhandled|TypeError|ReferenceError|panic:|is not a function)[^\n]*/,
  );
  return hit?.[0] ?? null;
}

async function boot(session: string, type?: string) {
  const app = await launch(session);
  if (type) {
    app.send(type);
    await app.until(() => app.output().includes(MARKER), "the shell marker to appear");
  }
  const out = app.output();
  const workspaceSummary = await app.workspaceSummary();
  await app.stop();
  return { out, workspaceSummary };
}

let first: { out: string; workspaceSummary: string };

beforeAll(async () => {
  // A shell prompt and a command that echoes something only we would write, so
  // "the pane is wired to a process" is answered by the process itself.
  first = await boot("e2e-boot-1", `echo ${MARKER}\r`);
}, E2E_TIMEOUT);

test("the first launch draws a screen", () => {
  expect(first.out.length).toBeGreaterThan(2000);
});

test("it persists one space with one agent", () => {
  expect(first.workspaceSummary).toBe("1sp 1win 1ag");
});

test("the pane runs a real shell", () => {
  expect(first.out).toContain(MARKER);
});

test("nothing crashed on the way up", () => {
  expect(crashed(first.out)).toBeNull();
});
