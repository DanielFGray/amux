/**
 * `^a N` opens a chat pane, and does not ask a question first.
 *
 * A native agent's first message used to come from a modal: the key opened a
 * prompt, and only the answer ran the command. Now the pane it opens IS the
 * composer, so the key dispatches straight to `agent.new` — a claim only
 * pressing it can settle, since the keymap will happily register a binding that
 * never dispatches (lrn-42d64b).
 *
 * A throwaway HOME holds no credential for the default model, so the command
 * stops at its preflight and says so. That is the point: the notice can only be
 * on screen if the key reached the command, and the check costs no API call.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { launch, LEADER, E2E_TIMEOUT, type App } from "./app.ts";

let app: App;
let screen = "";

beforeAll(async () => {
  app = await launch("e2e-agent");
  await app.press(`${LEADER}N`);
  await app.until(
    () => app.screen().includes("no credential stored for openai"),
    "agent.new to reach its preflight",
  );
  screen = app.screen();
}, E2E_TIMEOUT);

afterAll(async () => {
  await app?.stop();
});

test(
  "the new-agent key runs the command rather than opening a prompt",
  () => {
    expect(screen).toContain("no credential stored for openai");
    // The old flow's field label. Its absence is what says the modal is gone.
    expect(screen).not.toContain("what should the agent do?");
  },
  E2E_TIMEOUT,
);
