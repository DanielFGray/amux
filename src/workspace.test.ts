import { expect, test } from "bun:test";
import { command } from "./commands.ts";
import { resolve } from "node:path";
import { Effect, Cause } from "effect";
import {
  applyWorkspaceCommand,
  markSessionExited,
  parseWorkspace,
  parseWorkspaceCommandContext,
  parseWorkspaceJson,
  workspaceFromSession,
  workspaceSession,
} from "./workspace.ts";
import { layoutPanes } from "./layout.ts";
import type { SessionState } from "./session.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const runFailMessage = <E>(effect: Effect.Effect<unknown, E>): string => {
  const exit = Effect.runSyncExit(effect);
  if (exit._tag === "Success") throw new Error("expected effect to fail");
  const error = Cause.squash(exit.cause);
  return error instanceof Error ? error.message : String(error);
};

const base = (layout: string): SessionState => ({
  version: 1,
  id: "model",
  createdAt: 1,
  updatedAt: 1,
  attached: false,
  activeSpace: "space-a",
  spaces: [
    {
      id: "space-a",
      name: "project",
      dir: "/tmp",
      activeWindow: 1,
      windows: [
        {
          number: 1,
          name: null,
          agents: [
            {
              id: "agent-a",
              name: "cat",
              cmd: ["cat"],
              cols: 80,
              rows: 24,
              exited: false,
              exitCode: null,
            },
          ],
          layout,
        },
      ],
    },
  ],
});

const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

test("pane.close kills and removes the backend when its last pane closes", () => {
  expect(runFailMessage(workspaceFromSession(base("not json")))).toContain("layout is not JSON");
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const window = adopted.spaces[0]!.windows[0]!;
  expect(window.layout.root).not.toBeNull();

  const closed = applyWorkspaceCommand(adopted, command("pane.close"), context);
  expect(closed.changed).toBe(true);
  expect(closed.snapshot.revision).toBe(1);
  expect(closed.actions).toEqual([{ _tag: "kill", agent: "agent-a" }]);
  expect(closed.snapshot.spaces).toEqual([]);
});

test("transient window state stays live but is omitted from persistence", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const split = applyWorkspaceCommand(
    adopted,
    command("pane.split", { axis: "row" }),
    context,
  ).snapshot;
  const synced = applyWorkspaceCommand(
    split,
    command("window.synchronize-panes"),
    context,
  ).snapshot;
  expect(synced.spaces[0]!.windows[0]!.state.sync).toBe(true);
  expect(workspaceSession(synced, base("null")).spaces[0]!.windows[0]).not.toHaveProperty("state");
});

test("commands transform a private generation and leave their input untouched", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const renamed = applyWorkspaceCommand(
    adopted,
    command("space.rename", { name: "next" }),
    context,
  );
  expect(adopted.spaces[0]!.name).toBe("project");
  expect(renamed.snapshot.spaces[0]!.name).toBe("next");
  expect(renamed.snapshot.revision).toBe(adopted.revision + 1);
});

// A persisted roster can name a live agent the layout never shows. The model
// has no detached backend state, so adoption prunes it rather than restoring
// an invisible, supervised session; the exit then has nothing to reveal and
// removes the window.
test("adoption prunes a live agent no pane references, and its exit removes the window", () => {
  const saved = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
  );
  saved.spaces[0]!.windows[0]!.agents.push({
    id: "agent-b",
    name: "sleep",
    cmd: ["sleep", "30"],
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null,
  });
  const adopted = run(workspaceFromSession(saved));
  expect(adopted.spaces[0]!.windows[0]!.agents.map((agent) => agent.id)).toEqual(["agent-a"]);
  const exited = markSessionExited(adopted, "agent-a", 0);
  expect(exited.spaces).toEqual([]);
});

test("workspace and command context parsers reject malformed nested state and relationships", () => {
  const valid = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  expect(run(parseWorkspace(valid))).toEqual(valid);

  const badAgent = structuredClone(valid) as any;
  badAgent.spaces[0].windows[0].agents[0].cols = "wide";
  expect(runFailMessage(parseWorkspace(badAgent))).toContain("workspace does not match schema");
  const badFocus = structuredClone(valid);
  badFocus.spaces[0]!.windows[0]!.state.focus = "missing-pane";
  expect(runFailMessage(parseWorkspace(badFocus))).toContain("invalid pane");
  const badRelation = structuredClone(valid);
  (badRelation.spaces[0]!.windows[0]!.layout.root as any).content.session = "missing-agent";
  expect(runFailMessage(parseWorkspace(badRelation))).toContain("absent or exited session");

  expect(
    runFailMessage(
      parseWorkspaceCommandContext(
        { size: { cols: 0, rows: 24 }, shell: ["sh"], cwd: "/tmp" },
        valid,
      ),
    ),
  ).toContain("invalid workspace command context");
  expect(
    runFailMessage(
      parseWorkspaceCommandContext(
        {
          size: { cols: 1_000_000, rows: 1_000_000 },
          shell: ["sh"],
          cwd: "/tmp",
        },
        valid,
      ),
    ),
  ).toContain("invalid workspace command context");
  expect(
    runFailMessage(
      parseWorkspaceCommandContext({ ...context, blockedAgents: ["missing-agent"] }, valid),
    ),
  ).toContain("does not exist");
});

// The pane->agent edge is the model's one non-tree relationship: a window owns
// a roster and a pane tree joined by the pane's session id. Schema decodes
// structure, so parseWorkspace must check the references itself — every pane
// names a live agent in its own window, and every live agent is shown.
test("parseWorkspace rejects a float naming a session the window does not own", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const window = adopted.spaces[0]!.windows[0]!;
  window.layout = {
    version: 1,
    root: null,
    floats: [
      {
        id: "float-a",
        content: { kind: "pty", session: "missing-agent" },
        x: 0.1,
        y: 0.1,
        width: 0.5,
        height: 0.5,
      },
    ],
    focus: "float-a",
  };
  window.state.focus = "float-a";
  expect(runFailMessage(parseWorkspace(adopted))).toContain("does not have live");
});

test("parseWorkspace rejects a pane naming an agent another window owns", () => {
  const s = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
  );
  s.spaces[0]!.windows.push({
    number: 2,
    name: null,
    agents: [
      {
        id: "agent-b",
        name: "sh",
        cmd: ["sh"],
        cols: 80,
        rows: 24,
        exited: false,
        exitCode: null,
      },
    ],
    layout:
      '{"version":1,"root":{"type":"pane","id":"pane-b","content":{"kind":"pty","session":"agent-b"},"weight":1},"focus":"pane-b"}',
  });
  const adopted = run(workspaceFromSession(s));
  const foreign = adopted.spaces[0]!.windows[1]!;
  foreign.layout = {
    version: 1,
    root: null,
    floats: [
      {
        id: "float-x",
        content: { kind: "pty", session: "agent-a" },
        x: 0.1,
        y: 0.1,
        width: 0.5,
        height: 0.5,
      },
    ],
    focus: "float-x",
  };
  foreign.state.focus = "float-x";
  expect(runFailMessage(parseWorkspace(adopted))).toContain("does not have live");
});

test("parseWorkspace rejects a live agent that no pane references", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  adopted.spaces[0]!.windows[0]!.agents.push({
    id: "agent-b",
    name: "sleep",
    cmd: ["sleep", "30"],
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null,
  });
  expect(runFailMessage(parseWorkspace(adopted))).toContain("has no pane");
});

// Two panes showing one agent is the feature the non-tree edge exists for, and
// an exited agent keeps its record as a restart target after its pane is
// pruned — both remain legal.
test("parseWorkspace accepts duplicate panes on one agent", () => {
  const adopted = run(workspaceFromSession(dupAgentSession()));
  expect(run(parseWorkspace(adopted))).toEqual(adopted);
});

test("parseWorkspace accepts an exited agent no pane references", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  adopted.spaces[0]!.windows[0]!.agents.push({
    id: "agent-b",
    name: "sleep",
    cmd: ["sleep", "30"],
    cols: 80,
    rows: 24,
    exited: true,
    exitCode: 1,
  });
  const received = run(parseWorkspace(adopted));
  expect(received.spaces[0]!.windows[0]!.agents.map((agent) => agent.id)).toEqual([
    "agent-a",
    "agent-b",
  ]);
});

test("new identities are hierarchical, unique, and disjoint from adopted ids", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-adopted","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-adopted"}',
      ),
    ),
  );
  const first = applyWorkspaceCommand(
    adopted,
    command("pane.split", { axis: "row" }),
    context,
  ).snapshot;
  const second = applyWorkspaceCommand(
    first,
    command("pane.split", { axis: "column" }),
    context,
  ).snapshot;
  const agents = second.spaces[0]!.windows[0]!.agents.map((agent) => agent.id);
  const panes = second.spaces[0]!.windows[0]!.layout.root
    ? (JSON.stringify(second.spaces[0]!.windows[0]!.layout).match(/"id":"([^"]+)"/g) ?? [])
    : [];
  const paneIds = panes
    .map((match) => match.match(/"id":"([^"]+)"/)?.[1])
    .filter((id): id is string => id !== undefined);
  const minted = paneIds.filter((id) => !id.startsWith("pane-"));
  expect(new Set(agents).size).toBe(agents.length);
  expect(agents.slice(1).every((id) => /^agent-[0-9a-f-]{36}$/.test(id))).toBe(true);
  expect(new Set(paneIds).size).toBeGreaterThanOrEqual(2);
  expect(minted.length).toBeGreaterThanOrEqual(2);
  expect(minted.every((id) => /^[a-z0-9._-]+:p\d+$/.test(id))).toBe(true);
  expect(minted.every((id) => id.startsWith(second.spaces[0]!.id))).toBe(true);
  expect(agents).not.toContain("pane-adopted");
});

test("pane.split inherits the caller's cwd and accepts an override", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  // The space's own dir is /tmp; a caller working in a worktree must win.
  const worktree = { ...context, cwd: "/srv/worktrees/feature" };
  const inherited = applyWorkspaceCommand(
    adopted,
    command("pane.split", { axis: "row" }),
    worktree,
  ).snapshot;
  expect(inherited.spaces[0]!.windows[0]!.agents.at(-1)!.cwd).toBe("/srv/worktrees/feature");

  const overridden = applyWorkspaceCommand(
    adopted,
    command("pane.split", { axis: "row", cwd: "packages/app" }),
    worktree,
  ).snapshot;
  expect(overridden.spaces[0]!.windows[0]!.agents.at(-1)!.cwd).toBe(
    "/srv/worktrees/feature/packages/app",
  );
});

test("pane.close transfers focus to a survivor when the focused pane is closed", () => {
  const saved = base(
    '{"version":1,"root":{"type":"split","direction":"column","children":[{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},{"type":"pane","id":"pane-b","content":{"kind":"pty","session":"agent-b"},"weight":1},{"type":"pane","id":"pane-c","content":{"kind":"pty","session":"agent-c"},"weight":1}]},"focus":"pane-b"}',
  );
  saved.spaces[0]!.windows[0]!.agents.push(
    {
      id: "agent-b",
      name: "sh",
      cmd: ["sh"],
      cols: 80,
      rows: 24,
      exited: false,
      exitCode: null,
    },
    {
      id: "agent-c",
      name: "sh",
      cmd: ["sh"],
      cols: 80,
      rows: 24,
      exited: false,
      exitCode: null,
    },
  );
  const adopted = run(workspaceFromSession(saved));
  const closed = applyWorkspaceCommand(structuredClone(adopted), command("pane.close"), context);
  const window = closed.snapshot.spaces[0]!.windows[0]!;
  // pane-b was at index 1 in [pane-a, pane-b, pane-c]. focus → pane-c.
  expect(window.state.focus).toBe("pane-c");
  expect(window.layout.focus).toBe("pane-c");
});

test("closing the last pane kills the backend without revealing a hidden one", () => {
  const saved = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
  );
  saved.spaces[0]!.windows[0]!.agents.push({
    id: "agent-b",
    name: "sleep",
    cmd: ["sleep", "30"],
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null,
  });
  const adopted = run(workspaceFromSession(saved));
  expect(adopted.spaces[0]!.windows[0]!.agents.map((agent) => agent.id)).toEqual(["agent-a"]);
  const closed = applyWorkspaceCommand(adopted, command("pane.close"), context);
  expect(closed.actions).toEqual([{ _tag: "kill", agent: "agent-a" }]);
  expect(closed.snapshot.spaces).toEqual([]);
});

test("space.new uses node path resolution and basename semantics", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const next = applyWorkspaceCommand(
    adopted,
    command("space.new", { dir: "./tmp/../portable-project" }),
    context,
  ).snapshot;
  const created = next.spaces.at(-1)!;
  expect(created.dir).toBe(resolve("./tmp/../portable-project"));
  expect(created.name).toBe("portable-project");
});

// ── helpers for model-level command tests ──

const twoPaneLayout =
  '{"version":1,"root":{"type":"split","direction":"row","weight":1,"children":[{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},{"type":"pane","id":"pane-b","content":{"kind":"pty","session":"agent-b"},"weight":1}]},"focus":"pane-a"}';

function twoPaneSession(): SessionState {
  const s = base(twoPaneLayout);
  s.spaces[0]!.windows[0]!.agents.push({
    id: "agent-b",
    name: "sh",
    cmd: ["sh"],
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null,
  });
  return s;
}

const dupAgentLayout =
  '{"version":1,"root":{"type":"split","direction":"row","weight":1,"children":[{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},{"type":"pane","id":"pane-b","content":{"kind":"pty","session":"agent-a"},"weight":1}]},"focus":"pane-a"}';

function dupAgentSession(): SessionState {
  return base(dupAgentLayout);
}

const threePaneLayout =
  '{"version":1,"root":{"type":"split","direction":"column","weight":1,"children":[{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},{"type":"pane","id":"pane-b","content":{"kind":"pty","session":"agent-b"},"weight":1},{"type":"pane","id":"pane-c","content":{"kind":"pty","session":"agent-c"},"weight":1}]},"focus":"pane-b"}';

function threePaneSession(): SessionState {
  const s = base(threePaneLayout);
  s.spaces[0]!.windows[0]!.agents.push(
    {
      id: "agent-b",
      name: "sh",
      cmd: ["sh"],
      cols: 80,
      rows: 24,
      exited: false,
      exitCode: null,
    },
    {
      id: "agent-c",
      name: "sh",
      cmd: ["sh"],
      cols: 80,
      rows: 24,
      exited: false,
      exitCode: null,
    },
  );
  return s;
}

// ── pane.break ──

test("pane.break moves the focused pane into a new window", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const result = applyWorkspaceCommand(adopted, command("pane.break"), context);
  expect(result.changed).toBe(true);
  const space = result.snapshot.spaces[0]!;
  expect(space.windows).toHaveLength(2);

  const origin = space.windows[0]!;
  expect(origin.layout.root).not.toBeNull();
  const originPanes = JSON.stringify(origin.layout.root);
  expect(originPanes).toContain("pane-b");
  expect(originPanes).not.toContain("pane-a");

  const created = space.windows[1]!;
  expect(created.layout.root).toMatchObject({
    type: "pane",
    id: "pane-a",
    content: { kind: "pty", session: "agent-a" },
  });
  expect(created.state.focus).toBe("pane-a");
  expect(created.agents).toHaveLength(1);
  expect(created.agents[0]!.id).toBe("agent-a");

  expect(result.snapshot.revision).toBe(adopted.revision + 1);
});

test("pane.break moves a shared session once and closes its other source views", () => {
  const adopted = run(workspaceFromSession(dupAgentSession()));
  const result = applyWorkspaceCommand(adopted, command("pane.break"), context);
  expect(result.changed).toBe(true);
  const space = result.snapshot.spaces[0]!;
  expect(space.windows).toHaveLength(1);

  const broken = space.windows[0]!;
  expect(broken.layout.root).toMatchObject({
    type: "pane",
    id: "pane-a",
    content: { kind: "pty", session: "agent-a" },
  });
  expect(broken.state.focus).toBe("pane-a");

  expect(layoutPanes(broken.layout.root).map((pane) => pane.id)).toEqual(["pane-a"]);
  expect(broken.agents.map((agent) => agent.id)).toEqual(["agent-a"]);

  expect(result.snapshot.revision).toBe(adopted.revision + 1);
});

test("pane.join moves a shared session once and closes its other source views", () => {
  const adopted = run(workspaceFromSession(dupAgentSession()));
  const withDestination = applyWorkspaceCommand(adopted, command("window.new"), context).snapshot;
  const result = applyWorkspaceCommand(
    withDestination,
    command("pane.join", { source: 1 }),
    context,
  );

  const space = result.snapshot.spaces[0]!;
  expect(space.windows).toHaveLength(1);
  const destination = space.windows[0]!;
  expect(layoutPanes(destination.layout.root).map((pane) => pane.id)).toContain("pane-a");
  expect(layoutPanes(destination.layout.root).map((pane) => pane.id)).not.toContain("pane-b");
  expect(destination.agents.filter((agent) => agent.id === "agent-a")).toHaveLength(1);
});

test("pane.join moves a focused pane from the named window into the active window", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const withDestination = applyWorkspaceCommand(adopted, command("window.new"), context).snapshot;
  const result = applyWorkspaceCommand(
    withDestination,
    command("pane.join", { source: 1 }),
    context,
  );

  expect(result.changed).toBe(true);
  const space = result.snapshot.spaces[0]!;
  expect(space.windows).toHaveLength(2);
  const destination = space.windows[1]!;
  expect(layoutPanes(destination.layout.root).map((pane) => pane.content.session)).toEqual([
    expect.any(String),
    "agent-a",
  ]);
  expect(destination.agents.map((agent) => agent.id)).toContain("agent-a");
  expect(destination.state.focus).toBe("pane-a");
});

test("pane.join without a source uses the previously active window", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const withDestination = applyWorkspaceCommand(adopted, command("window.new"), context).snapshot;
  const result = applyWorkspaceCommand(withDestination, command("pane.join"), context);

  expect(result.changed).toBe(true);
  expect(
    layoutPanes(result.snapshot.spaces[0]!.windows[1]!.layout.root).map(
      (pane) => pane.content.session,
    ),
  ).toContain("agent-a");
});

test("pane.move transfers the focused pane to another space without killing it", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const withOther = applyWorkspaceCommand(
    adopted,
    command("space.new", { dir: "/tmp/other" }),
    context,
  ).snapshot;
  const other = withOther.spaces[1]!;
  const back = applyWorkspaceCommand(
    withOther,
    command("space.select", { space: adopted.spaces[0]!.id }),
    context,
  ).snapshot;
  const result = applyWorkspaceCommand(back, command("pane.move", { space: other.id }), context);

  expect(result.changed).toBe(true);
  expect(result.actions.filter((action) => action._tag === "kill")).toHaveLength(0);
  expect(result.snapshot.state.activeSpace).toBe(other.id);
  expect(
    layoutPanes(result.snapshot.spaces[0]!.windows[0]!.layout.root).map(
      (pane) => pane.content.session,
    ),
  ).toEqual(["agent-b"]);
  const movedSpace = result.snapshot.spaces.find((space) => space.id === other.id)!;
  expect(
    layoutPanes(movedSpace.windows[0]!.layout.root).map((pane) => pane.content.session),
  ).toContain("agent-a");
});

// ── pane.zoom ──

test("pane.zoom toggles zoom on and off", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const zoomed = applyWorkspaceCommand(adopted, command("pane.zoom"), context);
  expect(zoomed.changed).toBe(true);
  expect(zoomed.snapshot.spaces[0]!.windows[0]!.state.zoom).toEqual({
    pane: "pane-a",
    from: zoomed.snapshot.spaces[0]!.windows[0]!.state.zoom!.from,
  });
  expect(zoomed.snapshot.spaces[0]!.windows[0]!.state.zoom!.from.root).not.toBeNull();

  const unzoomed = applyWorkspaceCommand(zoomed.snapshot, command("pane.zoom"), context);
  expect(unzoomed.changed).toBe(true);
  expect(unzoomed.snapshot.spaces[0]!.windows[0]!.state.zoom).toBeNull();
});

test("pane.zoom on a single-pane window is a no-op", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const result = applyWorkspaceCommand(adopted, command("pane.zoom"), context);
  expect(result.changed).toBe(false);
});

// ── pane.float ──

test("pane.float moves the focused pane between the planes and back", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const floated = applyWorkspaceCommand(adopted, command("pane.float"), context);
  const window = () => floated.snapshot.spaces[0]!.windows[0]!;
  expect(floated.changed).toBe(true);
  expect(window().layout.floats.map((float) => float.id)).toEqual(["pane-a"]);
  expect(layoutPanes(window().layout.root).map((pane) => pane.id)).toEqual(["pane-b"]);
  // The pane the user was in is the pane the user is in: placement is not a
  // reason to move the keyboard.
  expect(window().state.focus).toBe("pane-a");

  const tiled = applyWorkspaceCommand(floated.snapshot, command("pane.float"), context);
  const back = tiled.snapshot.spaces[0]!.windows[0]!;
  expect(back.layout.floats).toEqual([]);
  expect(layoutPanes(back.layout.root).map((pane) => pane.id)).toEqual(["pane-b", "pane-a"]);
  expect(back.state.focus).toBe("pane-a");
});

// The daemon broadcasts every snapshot to its attached clients as JSON, and a
// client parses it before projecting. A float the daemon can hold but not send
// is a disconnect the moment the key is pressed.
test("a window with a float survives the trip to an attached client", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const floated = applyWorkspaceCommand(adopted, command("pane.float"), context).snapshot;
  const received = run(parseWorkspaceJson(JSON.stringify(floated)));
  expect(received.spaces[0]!.windows[0]!.layout).toEqual(floated.spaces[0]!.windows[0]!.layout);
});

// The daemon saves after every command and reloads from that save, so a layout
// it can produce but not read back is a crash one keystroke later.
test("a window with a float survives the save-and-reload round trip", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const floated = applyWorkspaceCommand(adopted, command("pane.float"), context).snapshot;
  const reloaded = run(workspaceFromSession(workspaceSession(floated, base("null"))));
  expect(reloaded.spaces[0]!.windows[0]!.layout).toEqual(floated.spaces[0]!.windows[0]!.layout);
});

// A sessionless plugin pane (the editor) is a real model state: it names a
// registered pane type and a descriptor, and no session. Both the wire and the
// save must carry the pane's type and descriptor verbatim — a schema that
// dropped them would leave the client unable to remount the view after a
// reconnect or restart.
test("a sessionless plugin pane survives the wire and the save round trip", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const withEditor = applyWorkspaceCommand(
    adopted,
    command("pane.split", { axis: "row" }),
    context,
  ).snapshot;
  const target = withEditor.spaces[0]!.windows[0]!;
  const pane = layoutPanes(target.layout.root)[1]!;
  // The split created a backend for the new pane; a sessionless plugin pane has
  // no backend, so its session leaves the roster with the pane's content.
  const orphan = pane.content.session;
  pane.content = {
    kind: "plugin",
    type: "amux.editor",
    descriptor: { file: "/work/note.txt" },
  };
  target.agents = target.agents.filter((agent) => agent.id !== orphan);
  const expected = target.layout;

  const received = run(parseWorkspaceJson(JSON.stringify(withEditor)));
  expect(received.spaces[0]!.windows[0]!.layout).toEqual(expected);

  const reloaded = run(workspaceFromSession(workspaceSession(withEditor, base("null"))));
  expect(reloaded.spaces[0]!.windows[0]!.layout).toEqual(expected);
});

// Cycling is the only way in and out of a float, since directional focus stays
// inside the tiled plane. What the arrows DO mean while a float is focused is
// movement: the pane covers the tiled plane, so there is nothing to focus
// across a shared edge, and the dead focus key becomes a move key instead.
test("pane.next reaches a float and comes back out of it", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const floated = applyWorkspaceCommand(adopted, command("pane.float"), context).snapshot;
  const focusAfterNext = (from: typeof floated) =>
    applyWorkspaceCommand(from, command("pane.next"), context).snapshot.spaces[0]!.windows[0]!.state
      .focus;
  // Order is tiled first, then floating: from the float it wraps to pane-b.
  expect(focusAfterNext(floated)).toBe("pane-b");
});

test("pane.focus moves a focused float one cell in the arrow's direction", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const floated = applyWorkspaceCommand(adopted, command("pane.float"), context).snapshot;
  const window = () => floated.spaces[0]!.windows[0]!;
  const x = () => window().layout.floats[0]!.x;
  const start = x();

  const moved = applyWorkspaceCommand(
    floated,
    command("pane.focus", { direction: "left" }),
    context,
  ).snapshot;
  expect(moved.spaces[0]!.windows[0]!.layout.floats[0]!.x).toBeCloseTo(start - 1 / 80);
  expect(moved.spaces[0]!.windows[0]!.state.focus).toBe("pane-a");
  // A float cannot be moved off the window: enough presses pile up against the
  // left edge and stop, without ever leaving focus or changing the rect's size.
  let current = floated;
  for (let i = 0; i < 200; i++) {
    current = applyWorkspaceCommand(
      current,
      command("pane.focus", { direction: "left" }),
      context,
    ).snapshot;
  }
  const squeezed = current.spaces[0]!.windows[0]!;
  expect(squeezed.layout.floats[0]!.x).toBe(0);
  expect(squeezed.layout.floats[0]!.width).toBeCloseTo(2 / 3);
});

test("pane.focus from a tiled pane still focuses directionally", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const result = applyWorkspaceCommand(adopted, command("pane.focus", { direction: "right" }), context);
  expect(result.changed).toBe(true);
  expect(result.snapshot.spaces[0]!.windows[0]!.state.focus).toBe("pane-b");
});

test("pane.resize resizes a focused float and leaves the preset intact", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const floated = applyWorkspaceCommand(adopted, command("pane.float"), context).snapshot;
  const withPreset = applyWorkspaceCommand(
    floated,
    command("window.select-layout", { preset: "even-horizontal" }),
    context,
  ).snapshot;
  const window = () => withPreset.spaces[0]!.windows[0]!;
  expect(window().layout.floats[0]!.id).toBe("pane-a");
  expect(window().state.preset).toBe("even-horizontal");
  const before = window().layout.floats[0]!;

  const resized = applyWorkspaceCommand(
    withPreset,
    command("pane.resize", { direction: "right" }),
    context,
  ).snapshot;
  const after = resized.spaces[0]!.windows[0]!;
  expect(after.layout.floats[0]!.width).toBeCloseTo(before.width + 1 / 80);
  expect(after.layout.floats[0]!.x).toBe(before.x);
  // A float is placed by its own rectangle, not the tree, so resizing it does
  // not break the preset's account of the tiled arrangement.
  expect(after.state.preset).toBe("even-horizontal");
});

test("pane.resize on a tiled pane still clears the preset", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const selected = applyWorkspaceCommand(
    adopted,
    command("window.select-layout", { preset: "even-horizontal" }),
    context,
  ).snapshot;
  const focusPaneB = applyWorkspaceCommand(
    selected,
    command("pane.select", { pane: "pane-b" }),
    context,
  ).snapshot;
  expect(focusPaneB.spaces[0]!.windows[0]!.state.preset).toBe("even-horizontal");

  const resized = applyWorkspaceCommand(
    focusPaneB,
    command("pane.resize", { direction: "left" }),
    context,
  ).snapshot;
  expect(resized.spaces[0]!.windows[0]!.state.preset).toBeNull();
});

// ── pane.swap ──

test("pane.swap next exchanges the focused pane with its neighbour", () => {
  const adopted = run(workspaceFromSession(threePaneSession()));
  const result = applyWorkspaceCommand(adopted, command("pane.swap", { to: "next" }), context);
  expect(result.changed).toBe(true);

  const panes = layoutPanes(result.snapshot.spaces[0]!.windows[0]!.layout.root);
  expect(panes).toHaveLength(3);
  // pane-b was focused at index 1; swapped with pane-c at index 2
  // after swap: pane order is [pane-a (agent-a), pane-c (agent-c), pane-b (agent-b)]
  expect(panes[0]!.content.session).toBe("agent-a");
  expect(panes[1]!.content.session).toBe("agent-c");
  expect(panes[2]!.content.session).toBe("agent-b");
});

// ── window.next / window.previous ──

test("window.next cycles to the next window", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const with2 = applyWorkspaceCommand(adopted, command("window.new"), context).snapshot;
  expect(with2.spaces[0]!.windows).toHaveLength(2);
  expect(with2.spaces[0]!.state.activeWindow).toBe(2);

  const next = applyWorkspaceCommand(with2, command("window.next"), context);
  expect(next.changed).toBe(true);
  expect(next.snapshot.spaces[0]!.state.activeWindow).toBe(1);
  expect(next.snapshot.spaces[0]!.state.lastWindow).toBe(2);
});

test("window.previous cycles to the previous window", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const with2 = applyWorkspaceCommand(adopted, command("window.new"), context).snapshot;
  expect(with2.spaces[0]!.state.activeWindow).toBe(2);

  const prev = applyWorkspaceCommand(with2, command("window.previous"), context);
  expect(prev.changed).toBe(true);
  expect(prev.snapshot.spaces[0]!.state.activeWindow).toBe(1);
});

// ── window.last ──

test("window.last returns to the last focused window", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const with3 = applyWorkspaceCommand(
    structuredClone(adopted),
    command("window.new"),
    context,
  ).snapshot;
  const with2next = applyWorkspaceCommand(with3, command("window.next"), context).snapshot;
  expect(with2next.spaces[0]!.state.activeWindow).toBe(1);
  expect(with2next.spaces[0]!.state.lastWindow).toBe(2);

  const last = applyWorkspaceCommand(with2next, command("window.last"), context);
  expect(last.changed).toBe(true);
  expect(last.snapshot.spaces[0]!.state.activeWindow).toBe(2);
});

// ── space.next / space.previous ──

test("space.next cycles to the next space", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const with2 = applyWorkspaceCommand(
    adopted,
    command("space.new", { dir: "/tmp/second" }),
    context,
  ).snapshot;
  expect(with2.spaces).toHaveLength(2);
  expect(with2.spaces.map((s) => s.id)).toEqual(["space-a", with2.spaces[1]!.id]);
  expect(with2.state.activeSpace).toBe(with2.spaces[1]!.id);

  const next = applyWorkspaceCommand(with2, command("space.next"), context);
  expect(next.changed).toBe(true);
  expect(next.snapshot.state.activeSpace).toBe("space-a");
});

test("space.previous cycles to the previous space", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
      ),
    ),
  );
  const with2 = applyWorkspaceCommand(
    adopted,
    command("space.new", { dir: "/tmp/second" }),
    context,
  ).snapshot;
  expect(with2.spaces).toHaveLength(2);
  expect(with2.state.activeSpace).toBe(with2.spaces[1]!.id);

  const prev = applyWorkspaceCommand(with2, command("space.previous"), context);
  expect(prev.changed).toBe(true);
  expect(prev.snapshot.state.activeSpace).toBe("space-a");
});

// ── agent.reveal ──

test("agent.reveal does nothing for an agent adoption pruned", () => {
  const s = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
  );
  s.spaces[0]!.windows[0]!.agents.push({
    id: "agent-b",
    name: "sleep",
    cmd: ["sleep", "30"],
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null,
  });
  const adopted = run(workspaceFromSession(s));
  const result = applyWorkspaceCommand(
    adopted,
    command("session.reveal", { session: "agent-b" }),
    context,
  );
  expect(result.changed).toBe(false);
});

test("agent.reveal on an already revealed agent just focuses it", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const result = applyWorkspaceCommand(
    adopted,
    command("session.reveal", { session: "agent-b" }),
    context,
  );
  expect(result.changed).toBe(true);
  const window = result.snapshot.spaces[0]!.windows[0]!;
  const panes = layoutPanes(window.layout.root);
  expect(panes).toHaveLength(2);
  expect(window.state.focus).toBe("pane-b");
});

// ── agent.next-blocked ──

test("agent.next-blocked jumps to the next blocked agent", () => {
  const s = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
  );
  s.spaces[0]!.windows[0]!.agents.push({
    id: "agent-b",
    name: "sleep",
    cmd: ["sleep", "30"],
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null,
  });
  // Give agent-b its own pane so it can be focused
  s.spaces[0]!.windows[0]!.layout =
    '{"version":1,"root":{"type":"split","direction":"row","weight":1,"children":[{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},{"type":"pane","id":"pane-b","content":{"kind":"pty","session":"agent-b"},"weight":1}]},"focus":"pane-a"}';
  const adopted = run(workspaceFromSession(s));
  const ctx = { ...context, blockedAgents: ["agent-a", "agent-b"] };
  const result = applyWorkspaceCommand(adopted, command("session.next-blocked"), ctx);
  expect(result.changed).toBe(true);
  expect(result.snapshot.spaces[0]!.windows[0]!.state.focus).toBe("pane-b");
});

// ── session.kill with surviving agent ──

test("session.kill removes the last backend once adoption pruned the detached one", () => {
  const s = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
  );
  s.spaces[0]!.windows[0]!.agents.push({
    id: "agent-b",
    name: "sleep",
    cmd: ["sleep", "30"],
    cols: 80,
    rows: 24,
    exited: false,
    exitCode: null,
  });
  const adopted = run(workspaceFromSession(s));
  const result = applyWorkspaceCommand(
    adopted,
    command("session.kill", { session: "agent-a" }),
    context,
  );
  expect(result.changed).toBe(true);
  expect(result.actions).toEqual([{ _tag: "kill", agent: "agent-a" }]);
  expect(result.snapshot.spaces).toEqual([]);
});

test("agent.restart revives an exited agent without changing its identity or pane", () => {
  const s = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
  );
  s.spaces[0]!.windows[0]!.agents.push({
    id: "agent-b",
    name: "worker",
    kind: "component",
    cmd: ["worker"],
    cols: 80,
    rows: 24,
    exited: true,
    exitCode: 17,
  });

  const adopted = run(workspaceFromSession(s));
  const agent = adopted.spaces[0]!.windows[0]!.agents[1]!;
  agent.exited = true;
  agent.exitCode = 17;
  const result = applyWorkspaceCommand(
    adopted,
    command("session.restart", { session: "agent-b" }),
    context,
  );

  expect(result.changed).toBe(true);
  expect(result.actions).toEqual([
    {
      _tag: "spawn",
      agent: expect.objectContaining({
        id: "agent-b",
        kind: "component",
        exited: false,
        exitCode: null,
      }),
      pane: "space-a:p1",
    },
  ]);
  expect(layoutPanes(result.snapshot.spaces[0]!.windows[0]!.layout.root)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        content: expect.objectContaining({ kind: "pty", session: "agent-a" }),
      }),
      expect.objectContaining({
        content: expect.objectContaining({ kind: "plugin", session: "agent-b" }),
      }),
    ]),
  );
});

// ── pane.resize-divider ──

test("pane.resize-divider adjusts neighbour weights", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const beforeLeft = JSON.stringify(
    (
      adopted.spaces[0]!.windows[0]!.layout.root as {
        type: "split";
        children: { weight: number }[];
      }
    ).children[0]!.weight,
  );
  const result = applyWorkspaceCommand(
    adopted,
    command("pane.resize-divider", { path: [], index: 0, delta: -5 }),
    context,
  );
  expect(result.changed).toBe(true);
  const afterLeft = JSON.stringify(
    (
      result.snapshot.spaces[0]!.windows[0]!.layout.root as {
        type: "split";
        children: { weight: number }[];
      }
    ).children[0]!.weight,
  );
  // The delta is applied in cell-equivalent space (cols: 80), so the weight of the left child should decrease
  expect(afterLeft).not.toBe(beforeLeft);
  expect(result.snapshot.spaces[0]!.windows[0]!.state.preset).toBeNull();
});

/* The answer has to reach the session that asked, and only that one: a
 * permission command names its session, and a command that names none is a
 * decision with nowhere to go rather than one applied to whatever is focused. */
test("agent.permission carries the answer to the session that asked", () => {
  const current = run(workspaceFromSession(base(twoPaneLayout)));
  const context = { cwd: "/tmp", shell: ["sh"], size: { cols: 80, rows: 24 } };
  const answered = applyWorkspaceCommand(
    current,
    command("agent.permission", {
      session: "agent-7",
      request: "req-1",
      decision: "reject",
      feedback: "not that file",
    }),
    context,
  );
  expect(answered.actions).toEqual([
    {
      _tag: "decide",
      agent: "agent-7",
      answer: {
        request: "req-1",
        decision: "reject",
        feedback: "not that file",
      },
    },
  ]);

  const unaddressed = applyWorkspaceCommand(
    current,
    command("agent.permission", { request: "req-1", decision: "once" }),
    context,
  );
  expect(unaddressed.actions).toEqual([]);
});

test("agent.new creates an agent session and queues its initial prompt", () => {
  const current = run(workspaceFromSession(base(twoPaneLayout)));
  const mutation = applyWorkspaceCommand(
    current,
    command("agent.new", {
      provider: "test",
      prompt: "Inspect this",
    }),
    {
      cwd: "/tmp",
      shell: ["sh"],
      size: { cols: 80, rows: 24 },
    },
  );
  const agent = mutation.snapshot.spaces[0]!.windows[0]!.agents.at(-1)!;
  const pane = mutation.snapshot.spaces[0]!.windows[0]!.layout.focus!;
  expect(mutation.result).toEqual({ session: agent.id, pane });
  expect(agent.kind).toBe("component");
  expect(agent.cmd).toBeUndefined();
  expect(agent.agent).toBe("test");
  expect(mutation.actions).toContainEqual({
    _tag: "prompt",
    agent: agent.id,
    text: "Inspect this",
  });
});

/* An agent that has not been asked anything is a normal state, not a half-built
 * one: the pane opens idle and its composer is where the first turn comes from.
 * A prompt with no text would open an empty turn instead. */
test("agent.new without a prompt starts the session and opens no turn", () => {
  const current = run(workspaceFromSession(base(twoPaneLayout)));
  const mutation = applyWorkspaceCommand(
    current,
    command("agent.new", {
      provider: "test",
    }),
    {
      cwd: "/tmp",
      shell: ["sh"],
      size: { cols: 80, rows: 24 },
    },
  );

  const agent = mutation.snapshot.spaces[0]!.windows[0]!.agents.at(-1)!;
  expect(agent.kind).toBe("component");
  expect(mutation.actions).toContainEqual(
    expect.objectContaining({ _tag: "spawn", agent, pane: expect.any(String) }),
  );
  expect(mutation.actions.some((action) => action._tag === "prompt")).toBe(false);
});

// ---------------------------------------------------------------------------
// The machine-facing read surface and pane targeting (ts-33067b).
// ---------------------------------------------------------------------------

/** Two spaces, one window each, the second with two panes. */
const wideBase = (): SessionState => ({
  version: 1,
  id: "model",
  createdAt: 1,
  updatedAt: 1,
  attached: false,
  activeSpace: "space-a",
  nextSpace: 1,
  spaces: [
    {
      id: "space-a",
      name: "one",
      dir: "/tmp/one",
      activeWindow: 1,
      windows: [
        {
          number: 1,
          name: null,
          agents: [
            {
              id: "agent-a",
              name: "cat",
              cmd: ["cat"],
              cols: 80,
              rows: 24,
              exited: false,
              exitCode: null,
            },
          ],
          layout:
            '{"version":1,"root":{"type":"pane","id":"pane-a","content":{"kind":"pty","session":"agent-a"},"weight":1},"focus":"pane-a"}',
        },
      ],
    },
    {
      id: "space-b",
      name: "two",
      dir: "/tmp/two",
      activeWindow: 1,
      windows: [
        {
          number: 1,
          name: null,
          agents: [
            {
              id: "agent-b1",
              name: "cat",
              cmd: ["cat"],
              cols: 80,
              rows: 24,
              exited: false,
              exitCode: null,
            },
            {
              id: "agent-b2",
              name: "cat",
              cmd: ["cat"],
              cols: 80,
              rows: 24,
              exited: false,
              exitCode: null,
            },
          ],
          layout:
            '{"version":1,"root":{"type":"split","direction":"row","weight":1,"children":[{"type":"pane","id":"pane-b1","content":{"kind":"pty","session":"agent-b1"},"weight":1},{"type":"pane","id":"pane-b2","content":{"kind":"pty","session":"agent-b2"},"weight":1}]},"focus":"pane-b2"}',
        },
      ],
    },
  ],
});

const wideContext = {
  ...context,
  // The calling agent lives in space-b's window; the workspace focus is b2.
  agent: "agent-b1",
  pane: "pane-b1",
};

test("space.list reports every space with its active window and count", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(adopted, command("space.list"), context);
  expect(mutation.changed).toBe(false);
  expect(mutation.actions).toEqual([]);
  expect(mutation.result).toEqual([
    { id: "space-a", name: "one", dir: "/tmp/one", activeWindow: 1, windows: 1 },
    { id: "space-b", name: "two", dir: "/tmp/two", activeWindow: 1, windows: 1 },
  ]);
});

test("window.list reports every window with its space, pane count and focus", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(adopted, command("window.list"), context);
  expect(mutation.changed).toBe(false);
  expect(mutation.result).toEqual([
    { space: "space-a", number: 1, name: null, panes: 1, active: true, focused: "pane-a" },
    { space: "space-b", number: 1, name: null, panes: 2, active: true, focused: "pane-b2" },
  ]);
});

test("pane.list reports every pane with its home, session and focus flags", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(adopted, command("pane.list"), context);
  expect(mutation.changed).toBe(false);
  expect(mutation.result).toEqual([
    { id: "pane-a", space: "space-a", window: 1, session: "agent-a", focused: true, zoomed: false },
    {
      id: "pane-b1",
      space: "space-b",
      window: 1,
      session: "agent-b1",
      focused: false,
      zoomed: false,
    },
    {
      id: "pane-b2",
      space: "space-b",
      window: 1,
      session: "agent-b2",
      focused: true,
      zoomed: false,
    },
  ]);
});

test("agent.list and agent.get report agents with their home and pane", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const list = applyWorkspaceCommand(adopted, command("agent.list"), context);
  expect(list.changed).toBe(false);
  expect(list.result).toEqual([
    expect.objectContaining({
      id: "agent-a",
      space: "space-a",
      window: 1,
      pane: "pane-a",
      exited: false,
    }),
    expect.objectContaining({ id: "agent-b1", space: "space-b", window: 1, pane: "pane-b1" }),
    expect.objectContaining({ id: "agent-b2", space: "space-b", window: 1, pane: "pane-b2" }),
  ]);
  const get = applyWorkspaceCommand(adopted, command("agent.get", { target: "agent-b2" }), context);
  expect(get.result).toEqual(
    expect.objectContaining({ id: "agent-b2", space: "space-b", window: 1, pane: "pane-b2" }),
  );
  const missing = applyWorkspaceCommand(
    adopted,
    command("agent.get", { target: "agent-gone" }),
    context,
  );
  expect(missing.result).toBeNull();
});

test("pane.current --current resolves the calling pane, not the focused pane", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(
    adopted,
    command("pane.current", { current: true }),
    wideContext,
  );
  expect(mutation.result).toEqual({
    id: "pane-b1",
    space: "space-b",
    window: 1,
    session: "agent-b1",
    focused: false,
    zoomed: false,
  });
});

test("pane.layout reports the pane's geometry and its window", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(
    adopted,
    command("pane.layout", { pane: "pane-b2" }),
    context,
  );
  const layout = mutation.result as {
    pane: string;
    size: { cols: number; rows: number };
    window: { cols: number; rows: number };
    panes: Array<{ id: string; x: number; y: number; cols: number; rows: number }>;
  } | null;
  expect(layout).not.toBeNull();
  expect(layout!.pane).toBe("pane-b2");
  expect(layout!.size).toEqual({ cols: 80, rows: 24 });
  expect(layout!.window).toEqual({ cols: 80, rows: 24 });
  // A row split divides the width; the two panes share the height.
  expect(layout!.panes).toHaveLength(2);
  expect(layout!.panes[0]!.cols).toBeLessThan(80);
  expect(layout!.panes[1]!.cols).toBeLessThan(80);
  expect(layout!.panes[0]!.rows).toBe(24);
});

test("pane.send-keys --pane names the target even when it is not focused", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(
    adopted,
    command("pane.send-keys", { keys: "x", pane: "pane-b1" }),
    context,
  );
  expect(mutation.actions).toEqual([{ _tag: "input", agent: "agent-b1", data: "x" }]);
  // Without a target the keys go to the workspace's focused pane (space-a's),
  // which is exactly why a caller in a managed pane must say --current/--pane.
  const focused = applyWorkspaceCommand(adopted, command("pane.send-keys", { keys: "y" }), context);
  expect(focused.actions).toEqual([{ _tag: "input", agent: "agent-a", data: "y" }]);
});

test("pane.send-keys --current targets the caller's own pane", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(
    adopted,
    command("pane.send-keys", { keys: "x", current: true }),
    wideContext,
  );
  expect(mutation.actions).toEqual([{ _tag: "input", agent: "agent-b1", data: "x" }]);
});

test("pane.split --pane splits the named pane wherever it lives", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(
    adopted,
    command("pane.split", { axis: "row", pane: "pane-a" }),
    context,
  );
  expect(mutation.changed).toBe(true);
  const spaceA = mutation.snapshot.spaces.find((s) => s.id === "space-a")!;
  const panes =
    spaceA.windows[0]!.layout.root === null
      ? []
      : (JSON.stringify(spaceA.windows[0]!.layout)
          .match(/"id":"([^"]+)"/g)
          ?.map((m) => m.match(/"id":"([^"]+)"/)![1]!) ?? []);
  expect(panes).toContain("pane-a");
  expect(panes.some((id) => id.startsWith("space-a:p"))).toBe(true);
});

test("pane.close --pane closes the named pane, keeping the human's focus", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(
    adopted,
    command("pane.close", { pane: "pane-b1" }),
    context,
  );
  expect(mutation.changed).toBe(true);
  const spaceB = mutation.snapshot.spaces.find((s) => s.id === "space-b")!;
  const ids = JSON.stringify(spaceB.windows[0]!.layout).match(/"id":"([^"]+)"/g) ?? [];
  expect(ids.join()).not.toContain("pane-b1");
});

test("--no-focus splits without moving the focused pane", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(adopted, command("pane.split", { axis: "row" }), {
    ...wideContext,
    noFocus: true,
  });
  expect(mutation.changed).toBe(true);
  const spaceB = mutation.snapshot.spaces.find((s) => s.id === "space-b")!;
  const window = spaceB.windows[0]!;
  // The new pane exists, but focus stays where the caller left it.
  expect(layoutPanes(window.layout.root).length).toBe(3);
  expect(window.state.focus).toBe("pane-b2");
  expect(window.layout.focus).toBe("pane-b2");
});

test("--no-focus space.new creates the space without activating it", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(adopted, command("space.new", { name: "extra" }), {
    ...context,
    noFocus: true,
  });
  expect(mutation.changed).toBe(true);
  expect(mutation.snapshot.spaces).toHaveLength(3);
  expect(mutation.snapshot.state.activeSpace).toBe("space-a");
});

test("pane.move crosses spaces, re-ids the pane, and reports the old id", () => {
  const adopted = run(workspaceFromSession(wideBase()));
  const mutation = applyWorkspaceCommand(
    adopted,
    command("pane.move", { space: "space-a", pane: "pane-b1" }),
    context,
  );
  expect(mutation.changed).toBe(true);
  const result = mutation.result as { pane: string; previous_pane_id: string } | undefined;
  expect(result).toBeDefined();
  expect(result!.previous_pane_id).toBe("pane-b1");
  expect(result!.pane.startsWith("space-a:p")).toBe(true);
  // The old id is gone everywhere; the moved session now lives in space-a.
  expect(JSON.stringify(mutation.snapshot)).not.toContain("pane-b1");
  const spaceA = mutation.snapshot.spaces.find((s) => s.id === "space-a")!;
  const spaceB = mutation.snapshot.spaces.find((s) => s.id === "space-b")!;
  expect(spaceA.windows[0]!.agents.map((a) => a.id)).toContain("agent-b1");
  expect(spaceB.windows[0]!.agents.map((a) => a.id)).not.toContain("agent-b1");
});

test("a closed pane id is never reissued to the next pane", () => {
  let adopted = run(workspaceFromSession(wideBase()));
  const split = applyWorkspaceCommand(adopted, command("pane.split", { axis: "row" }), context);
  const created = split.result as { pane: string };
  adopted = split.snapshot;
  const closed = applyWorkspaceCommand(
    adopted,
    command("pane.close", { pane: created.pane }),
    context,
  );
  const reopened = applyWorkspaceCommand(
    closed.snapshot,
    command("pane.split", { axis: "row" }),
    context,
  );
  const again = reopened.result as { pane: string };
  expect(again.pane).not.toBe(created.pane);
  // The counter only advances: the fresh id is strictly newer.
  const counterOf = (id: string) => Number(id.match(/:p(\d+)$/)![1]);
  expect(counterOf(again.pane)).toBeGreaterThan(counterOf(created.pane));
});
