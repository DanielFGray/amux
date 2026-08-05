/**
 * The commands that change the workspace actually change it.
 *
 * Written for ts-456094, where every closing command was a no-op: Phase 5b
 * turned closeWindow, breakPane, killAgent and remove into Effects and the
 * eight call sites in app.tsx went on calling them as statements. An Effect
 * nobody runs does nothing, and an unused expression statement is legal
 * TypeScript, so neither the typecheck nor the suite said a word.
 *
 * Each step is checked against the persisted workspace, and the steps build on
 * each other so a command that half-worked shows up as the wrong shape at the
 * next one — which is why they share an app and run in order. The file is the
 * app's own account of its state rather than a rendering of it, which is what
 * makes a silent no-op visible.
 *
 * Every step also checks the sidebar footer against that same file. Two
 * accounts of one workspace that have to agree: the tree on screen and the
 * state on disk. This is the claim ts-9beb5d was filed about, and could not
 * have been settled by reading `output()` — see App.screen().
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { launch, LEADER, E2E_TIMEOUT, type App } from "./app.ts";

let app: App;

beforeAll(async () => {
  app = await launch("e2e-workspace");
  expect(await app.shape()).toBe("1sp 1win 1ag");
}, E2E_TIMEOUT);

afterAll(async () => {
  await app?.stop();
});

/** "1sp 2win 2ag" as the sidebar footer would write it. */
function footerFor(shape: string): string {
  const [spaces, , agents] = shape.split(" ").map((part) => Number.parseInt(part, 10));
  return `${spaces} space${spaces === 1 ? "" : "s"} · ${agents} agent${agents === 1 ? "" : "s"}`;
}

/** Press, then hold BOTH accounts of the workspace to the same shape. */
async function step(keys: string, want: string) {
  await app.press(keys);
  await app.until(
    async () => (await app.shape()) === want && app.screen().includes(footerFor(want)),
    `the workspace and sidebar to reach ${want}`,
  );
  const shape = await app.shape();
  expect(shape).toBe(want);
  expect(app.screen()).toContain(footerFor(shape));
}

test(
  "new window adds a window and an agent",
  async () => {
    await step(`${LEADER}c`, "1sp 2win 2ag");
  },
  E2E_TIMEOUT,
);

test(
  "kill window takes its agent with it",
  async () => {
    await step(`${LEADER}&`, "1sp 1win 1ag");
  },
  E2E_TIMEOUT,
);

test(
  "split adds an agent to the window",
  async () => {
    await step(`${LEADER}|`, "1sp 1win 2ag");
  },
  E2E_TIMEOUT,
);

test(
  "daemon pane.break publishes a projection that keeps the moved PTY",
  async () => {
    const before = await app.session();
    const source = before!.spaces[0].windows.find(
      (window: any) => window.number === before!.spaces[0].activeWindow,
    );
    const focused = JSON.parse(source.layout).focus;
    const movedAgent = JSON.parse(source.layout).root.children.find(
      (pane: any) => pane.id === focused,
    ).agent;
    await step(`${LEADER}!`, "1sp 2win 2ag");
    const after = await app.session();
    const projected = after!.spaces[0].windows.find(
      (window: any) => window.number === after!.spaces[0].activeWindow,
    );
    expect(projected.agents.map((agent: any) => agent.id)).toEqual([movedAgent]);
    expect(JSON.parse(projected.layout).root.agent).toBe(movedAgent);
    app.send("printf 'break-still-live\\n'\n");
    await app.until(
      () => app.screen().includes("break-still-live"),
      "the moved pane's PTY to remain alive",
    );
  },
  E2E_TIMEOUT,
);

// ts-8d06b3: killing the last agent in a window takes the window with it,
// exactly as the agent exiting on its own would. This asserted the window
// being left behind until killAgent joined the exit cascade.
test(
  "kill agent takes its emptied window with it",
  async () => {
    await step(`${LEADER}K`, "1sp 1win 1ag");
  },
  E2E_TIMEOUT,
);

// Killing the LAST agent runs the cascade to its end: the window closes, then
// the space, then the app itself. That escalation is the point of ts-8d06b3 —
// it is what typing `exit` in the only shell already did, and a kill has to
// mean the same thing — but it is also the most surprising thing in this file,
// so it is checked rather than assumed. Last step: nothing survives it, so
// there is no footer left to agree with.
test(
  "killing the last agent empties the workspace and quits",
  async () => {
    await app.press(`${LEADER}K`);
    await app.until(
      async () => (await app.shape()) === "0sp 0win 0ag",
      "the empty workspace to persist",
    );
    expect(await app.shape()).toBe("0sp 0win 0ag");
  },
  E2E_TIMEOUT,
);
