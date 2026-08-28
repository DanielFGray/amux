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
 * each other so a command that half-worked shows up as the wrong summary at the
 * next one — which is why they share an app and run in order. The file is the
 * app's own account of its state rather than a rendering of it, which is what
 * makes a silent no-op visible.
 *
 * Every step also checks the sidebar footer against that same file. Two
 * accounts of one workspace that have to agree: the tree on screen and the
 * state on disk. This is the claim ts-9beb5d was filed about, and could not
 * have been settled by reading `output()` — see App.screen().
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { launch, teeColumn, LEADER, E2E_TIMEOUT, type App } from "./app.ts";

let app: App;

beforeAll(async () => {
  app = await launch("e2e-workspace");
  expect(await app.workspaceSummary()).toBe("1sp 1win 1ag");
}, E2E_TIMEOUT);

afterAll(async () => {
  await app?.stop();
});

/** "1sp 2win 2ag" as the sidebar footer would write it. */
function footerFor(fixture: string): string {
  const [spaces, , agents] = fixture.split(" ").map((part) => Number.parseInt(part, 10));
  return `${spaces} space${spaces === 1 ? "" : "s"} · ${agents} agent${agents === 1 ? "" : "s"}`;
}

type PersistedLayout = {
  root: { type: string } | null;
  floats: readonly unknown[];
};

async function activeLayout(): Promise<PersistedLayout | null> {
  const session = await app.session();
  const space = session?.spaces?.[0];
  const window = space?.windows.find((candidate) => candidate.number === space.activeWindow);
  if (typeof window?.layout !== "string") return null;
  return JSON.parse(window.layout) as PersistedLayout;
}

const cornerRows = (screen: string) =>
  screen
    .split("\n")
    .map((line, row) => (line.includes("┌") ? row : -1))
    .filter((row) => row !== -1);

/** Press, then hold BOTH accounts of the workspace to the same summary. */
async function step(keys: string, want: string) {
  await app.press(keys);
  await app.until(
    async () => (await app.workspaceSummary()) === want && app.screen().includes(footerFor(want)),
    `the workspace and sidebar to reach ${want}`,
  );
  const summary = await app.workspaceSummary();
  expect(summary).toBe(want);
  expect(app.screen()).toContain(footerFor(summary));
}

test(
  "the real agent.new binding reaches its preflight without opening the old prompt",
  async () => {
    await app.press(`${LEADER}N`);
    await app.until(
      () => app.screen().includes("no credential stored for openai"),
      "agent.new to reach its preflight",
    );
    expect(app.screen()).not.toContain("what should the agent do?");
    expect(await app.workspaceSummary()).toBe("1sp 1win 1ag");
  },
  E2E_TIMEOUT,
);

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
  "pane.float crosses the daemon projection and renderer in both directions",
  async () => {
    await app.press(`${LEADER}f`);
    await app.until(async () => {
      const layout = await activeLayout();
      return layout?.floats.length === 1 && teeColumn(app.screen()) === -1;
    }, "the focused pane to float in persisted state and on screen");
    expect(cornerRows(app.screen())).toHaveLength(2);

    await app.press(`${LEADER}f`);
    await app.until(async () => {
      const layout = await activeLayout();
      return layout?.floats.length === 0 && teeColumn(app.screen()) !== -1;
    }, "the focused pane to return to the tiled layout");
    expect(cornerRows(app.screen())).toHaveLength(1);
    expect(await app.workspaceSummary()).toBe("1sp 1win 2ag");
  },
  E2E_TIMEOUT,
);

test(
  "daemon pane.break publishes a projection that keeps the moved PTY",
  async () => {
    const before = await app.session();
    if (!before?.spaces?.[0]) throw new Error("workspace has no space before pane.break");
    const spaceBefore = before.spaces[0];
    const source = spaceBefore.windows.find((window) => window.number === spaceBefore.activeWindow);
    if (!source) throw new Error("workspace has no active window before pane.break");
    const focused = JSON.parse(source.layout).focus;
    const movedAgent = JSON.parse(source.layout).root.children.find(
      (pane: { id: string; content: { session?: string } }) => pane.id === focused,
    ).content.session;
    await step(`${LEADER}!`, "1sp 2win 2ag");
    const after = await app.session();
    if (!after?.spaces?.[0]) throw new Error("workspace has no space after pane.break");
    const spaceAfter = after.spaces[0];
    const projected = spaceAfter.windows.find(
      (window) => window.number === spaceAfter.activeWindow,
    );
    if (!projected) throw new Error("workspace has no active window after pane.break");
    expect(projected.sessions.map((session) => session.id)).toEqual([movedAgent]);
    expect(JSON.parse(projected.layout).root.content.session).toBe(movedAgent);
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
    // The empty state is persisted, then `stopWhenEmpty` (daemon.ts) tears the
    // session directory down once the client detaches — "stop ends the
    // session: its directory goes". That teardown can land inside a single
    // poll interval, so a run may observe the emptied file or its removal;
    // either is proof nothing survived the cascade.
    await app.press(`${LEADER}K`);
    await app.until(async () => {
      const summary = await app.workspaceSummary();
      return summary === "0sp 0win 0ag" || summary === "(no session file)";
    }, "the workspace to empty and the session to tear down");
  },
  E2E_TIMEOUT,
);
