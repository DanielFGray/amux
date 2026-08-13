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
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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

test("a natural exit reveals a surviving detached agent", () => {
  const saved = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
  const exited = markSessionExited(run(workspaceFromSession(saved)), "agent-a", 0);
  const window = exited.spaces[0]!.windows[0]!;
  expect(window.layout.root).toMatchObject({ type: "pane", agent: "agent-b" });
  expect(window.state.focus).toBe(window.layout.focus ?? null);
});

test("workspace and command context parsers reject malformed nested state and relationships", () => {
  const valid = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
  (badRelation.spaces[0]!.windows[0]!.layout.root as any).agent = "missing-agent";
  expect(runFailMessage(parseWorkspace(badRelation))).toContain("absent or exited agent");

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

test("new identities are UUID-based, unique, and disjoint from adopted ids", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-adopted","agent":"agent-a","weight":1},"focus":"pane-adopted"}',
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
  const panes = JSON.stringify(second).match(/pane-[0-9a-f-]{36}/g) ?? [];
  expect(new Set(agents).size).toBe(agents.length);
  expect(agents.slice(1).every((id) => /^agent-[0-9a-f-]{36}$/.test(id))).toBe(true);
  expect(new Set(panes).size).toBeGreaterThanOrEqual(2);
  expect(agents).not.toContain("pane-adopted");
});

test("pane.close transfers focus to a survivor when the focused pane is closed", () => {
  const saved = base(
    '{"version":1,"root":{"type":"split","direction":"column","children":[{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},{"type":"pane","id":"pane-b","agent":"agent-b","weight":1},{"type":"pane","id":"pane-c","agent":"agent-c","weight":1}]},"focus":"pane-b"}',
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

test("pane.close does not reveal an unreferenced backend", () => {
  const saved = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
  const closed = applyWorkspaceCommand(adopted, command("pane.close"), context);
  expect(closed.actions).toEqual([
    { _tag: "kill", agent: "agent-a" },
    { _tag: "kill", agent: "agent-b" },
  ]);
  expect(closed.snapshot.spaces).toEqual([]);
});

test("space.new uses node path resolution and basename semantics", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
  '{"version":1,"root":{"type":"split","direction":"row","weight":1,"children":[{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},{"type":"pane","id":"pane-b","agent":"agent-b","weight":1}]},"focus":"pane-a"}';

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
  '{"version":1,"root":{"type":"split","direction":"row","weight":1,"children":[{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},{"type":"pane","id":"pane-b","agent":"agent-a","weight":1}]},"focus":"pane-a"}';

function dupAgentSession(): SessionState {
  return base(dupAgentLayout);
}

const threePaneLayout =
  '{"version":1,"root":{"type":"split","direction":"column","weight":1,"children":[{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},{"type":"pane","id":"pane-b","agent":"agent-b","weight":1},{"type":"pane","id":"pane-c","agent":"agent-c","weight":1}]},"focus":"pane-b"}';

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
    agent: "agent-a",
  });
  expect(created.state.focus).toBe("pane-a");
  expect(created.agents).toHaveLength(1);
  expect(created.agents[0]!.id).toBe("agent-a");

  expect(result.snapshot.revision).toBe(adopted.revision + 1);
});

test("pane.break when two panes show the same agent clones the agent to both windows", () => {
  const adopted = run(workspaceFromSession(dupAgentSession()));
  const result = applyWorkspaceCommand(adopted, command("pane.break"), context);
  expect(result.changed).toBe(true);
  const space = result.snapshot.spaces[0]!;
  expect(space.windows).toHaveLength(2);

  const origin = space.windows[0]!;
  const originPanes = JSON.stringify(origin.layout.root);
  expect(originPanes).toContain("pane-b");
  expect(originPanes).not.toContain("pane-a");

  const broken = space.windows[1]!;
  expect(broken.layout.root).toMatchObject({
    type: "pane",
    id: "pane-a",
    agent: "agent-a",
  });
  expect(broken.state.focus).toBe("pane-a");

  expect(origin.agents[0]!.id).toBe("agent-a");
  expect(broken.agents[0]!.id).toBe("agent-a");
  expect(origin.agents[0]).not.toBe(broken.agents[0]);

  expect(result.snapshot.revision).toBe(adopted.revision + 1);
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
  expect(layoutPanes(destination.layout.root).map((pane) => pane.agent)).toEqual([
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
    layoutPanes(result.snapshot.spaces[0]!.windows[1]!.layout.root).map((pane) => pane.agent),
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
    layoutPanes(result.snapshot.spaces[0]!.windows[0]!.layout.root).map((pane) => pane.agent),
  ).toEqual(["agent-b"]);
  const movedSpace = result.snapshot.spaces.find((space) => space.id === other.id)!;
  expect(layoutPanes(movedSpace.windows[0]!.layout.root).map((pane) => pane.agent)).toContain(
    "agent-a",
  );
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
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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

// Cycling is the only way in and out of a float, since directional focus stays
// inside the tiled plane.
test("pane.next reaches a float and comes back out of it", () => {
  const adopted = run(workspaceFromSession(twoPaneSession()));
  const floated = applyWorkspaceCommand(adopted, command("pane.float"), context).snapshot;
  const focusAfterNext = (from: typeof floated) =>
    applyWorkspaceCommand(from, command("pane.next"), context).snapshot.spaces[0]!.windows[0]!.state
      .focus;
  // Order is tiled first, then floating: from the float it wraps to pane-b.
  expect(focusAfterNext(floated)).toBe("pane-b");
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
  expect(panes[0]!.agent).toBe("agent-a");
  expect(panes[1]!.agent).toBe("agent-c");
  expect(panes[2]!.agent).toBe("agent-b");
});

// ── window.next / window.previous ──

test("window.next cycles to the next window", () => {
  const adopted = run(
    workspaceFromSession(
      base(
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
        '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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

test("agent.reveal creates a pane for an unrevealed agent", () => {
  const s = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
  expect(result.changed).toBe(true);

  const window = result.snapshot.spaces[0]!.windows[0]!;
  const panes = JSON.stringify(window.layout.root);
  expect(panes).toContain("agent-b");
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
    '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
    '{"version":1,"root":{"type":"split","direction":"row","weight":1,"children":[{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},{"type":"pane","id":"pane-b","agent":"agent-b","weight":1}]},"focus":"pane-a"}';
  const adopted = run(workspaceFromSession(s));
  const ctx = { ...context, blockedAgents: ["agent-a", "agent-b"] };
  const result = applyWorkspaceCommand(adopted, command("session.next-blocked"), ctx);
  expect(result.changed).toBe(true);
  expect(result.snapshot.spaces[0]!.windows[0]!.state.focus).toBe("pane-b");
});

// ── agent.kill with surviving agent ──

test("session.kill removes unreferenced backends", () => {
  const s = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
  expect(result.actions).toEqual([
    { _tag: "kill", agent: "agent-a" },
    { _tag: "kill", agent: "agent-b" },
  ]);
  expect(result.snapshot.spaces).toEqual([]);
});

test("agent.restart revives an exited agent without changing its identity or pane", () => {
  const s = base(
    '{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}',
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
    },
  ]);
  expect(layoutPanes(result.snapshot.spaces[0]!.windows[0]!.layout.root)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ agent: "agent-a" }),
      expect.objectContaining({ agent: "agent-b" }),
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
  expect(mutation.actions).toContainEqual({ _tag: "spawn", agent });
  expect(mutation.actions.some((action) => action._tag === "prompt")).toBe(false);
});
