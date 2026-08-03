import { expect, test } from "bun:test"
import { command } from "./commands.ts"
import { resolve } from "node:path"
import {
  applyWorkspaceCommand,
  markAgentExited,
  parseWorkspace,
  parseWorkspaceCommandContext,
  workspaceFromSession,
  workspaceSession,
} from "./workspace.ts"
import type { SessionState } from "./session.ts"

const base = (layout: string): SessionState => ({
  version: 1,
  id: "model",
  createdAt: 1,
  updatedAt: 1,
  attached: false,
  activeSpace: "space-a",
  spaces: [{
    id: "space-a",
    name: "project",
    dir: "/tmp",
    activeWindow: 1,
    windows: [{
      number: 1,
      name: null,
      agents: [{ id: "agent-a", name: "cat", cmd: ["cat"], cols: 80, rows: 24, exited: false, exitCode: null }],
      layout,
    }],
  }],
})

const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" }

test("pane.close reveals a live agent when the window would become empty", () => {
  expect(() => workspaceFromSession(base("not json"))).toThrow("layout is not JSON")
  const adopted = workspaceFromSession(base('{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}'))
  const window = adopted.spaces[0]!.windows[0]!
  expect(window.layout.root).not.toBeNull()

  const closed = applyWorkspaceCommand(adopted, command("pane.close"), context)
  expect(closed.changed).toBe(true)
  expect(closed.snapshot.revision).toBe(1)
  // agent-a exited:false, so it is re-revealed rather than leaving the window empty
  const after = closed.snapshot.spaces[0]!.windows[0]!
  expect(after.layout.root).not.toBeNull()
  expect(after.state.focus).not.toBeNull()
})

test("transient window state stays live but is omitted from persistence", () => {
  const adopted = workspaceFromSession(base('{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}'))
  const split = applyWorkspaceCommand(adopted, command("pane.split", { axis: "row" }), context).snapshot
  const synced = applyWorkspaceCommand(split, command("window.synchronize-panes"), context).snapshot
  expect(synced.spaces[0]!.windows[0]!.state.sync).toBe(true)
  expect(workspaceSession(synced, base("null")).spaces[0]!.windows[0]).not.toHaveProperty("state")
})

test("commands transform a private generation and leave their input untouched", () => {
  const adopted = workspaceFromSession(base('{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}'))
  const renamed = applyWorkspaceCommand(adopted, command("space.rename", { name: "next" }), context)
  expect(adopted.spaces[0]!.name).toBe("project")
  expect(renamed.snapshot.spaces[0]!.name).toBe("next")
  expect(renamed.snapshot.revision).toBe(adopted.revision + 1)
})

test("a natural exit reveals a surviving detached agent", () => {
  const saved = base('{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}')
  saved.spaces[0]!.windows[0]!.agents.push({
    id: "agent-b", name: "sleep", cmd: ["sleep", "30"], cols: 80, rows: 24, exited: false, exitCode: null,
  })
  const exited = markAgentExited(workspaceFromSession(saved), "agent-a", 0)
  const window = exited.spaces[0]!.windows[0]!
  expect(window.layout.root).toMatchObject({ type: "pane", agent: "agent-b" })
  expect(window.state.focus).toBe(window.layout.focus ?? null)
})

test("workspace and command context parsers reject malformed nested state and relationships", () => {
  const valid = workspaceFromSession(base('{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}'))
  expect(parseWorkspace(valid)).toEqual(valid)

  const badAgent = structuredClone(valid) as any
  badAgent.spaces[0].windows[0].agents[0].cols = "wide"
  expect(() => parseWorkspace(badAgent)).toThrow()
  const badFocus = structuredClone(valid)
  badFocus.spaces[0]!.windows[0]!.state.focus = "missing-pane"
  expect(() => parseWorkspace(badFocus)).toThrow("invalid pane")
  const badRelation = structuredClone(valid)
  ;(badRelation.spaces[0]!.windows[0]!.layout.root as any).agent = "missing-agent"
  expect(() => parseWorkspace(badRelation)).toThrow("absent or exited agent")

  expect(() => parseWorkspaceCommandContext({ size: { cols: 0, rows: 24 }, shell: ["sh"], cwd: "/tmp" }, valid)).toThrow()
  expect(() => parseWorkspaceCommandContext({ size: { cols: 1_000_000, rows: 1_000_000 }, shell: ["sh"], cwd: "/tmp" }, valid)).toThrow()
  expect(() => parseWorkspaceCommandContext({ ...context, blockedAgents: ["missing-agent"] }, valid)).toThrow("does not exist")
})

test("new identities are UUID-based, unique, and disjoint from adopted ids", () => {
  const adopted = workspaceFromSession(base('{"version":1,"root":{"type":"pane","id":"pane-adopted","agent":"agent-a","weight":1},"focus":"pane-adopted"}'))
  const first = applyWorkspaceCommand(adopted, command("pane.split", { axis: "row" }), context).snapshot
  const second = applyWorkspaceCommand(first, command("pane.split", { axis: "column" }), context).snapshot
  const agents = second.spaces[0]!.windows[0]!.agents.map((agent) => agent.id)
  const panes = (JSON.stringify(second).match(/pane-[0-9a-f-]{36}/g) ?? [])
  expect(new Set(agents).size).toBe(agents.length)
  expect(agents.slice(1).every((id) => /^agent-[0-9a-f-]{36}$/.test(id))).toBe(true)
  expect(new Set(panes).size).toBeGreaterThanOrEqual(2)
  expect(agents).not.toContain("pane-adopted")
})

test("pane.close transfers focus to a survivor when the focused pane is closed", () => {
  const saved = base('{"version":1,"root":{"type":"split","direction":"column","children":[{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},{"type":"pane","id":"pane-b","agent":"agent-b","weight":1},{"type":"pane","id":"pane-c","agent":"agent-c","weight":1}]},"focus":"pane-b"}')
  saved.spaces[0]!.windows[0]!.agents.push(
    { id: "agent-b", name: "sh", cmd: ["sh"], cols: 80, rows: 24, exited: false, exitCode: null },
    { id: "agent-c", name: "sh", cmd: ["sh"], cols: 80, rows: 24, exited: false, exitCode: null },
  )
  const adopted = workspaceFromSession(saved)
  const closed = applyWorkspaceCommand(structuredClone(adopted), command("pane.close"), context)
  const window = closed.snapshot.spaces[0]!.windows[0]!
  // pane-b was at index 1 in [pane-a, pane-b, pane-c]. focus → pane-c.
  expect(window.state.focus).toBe("pane-c")
  expect(window.layout.focus).toBe("pane-c")
})

test("pane.close on the last pane reveals a live agent", () => {
  const saved = base('{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}')
  saved.spaces[0]!.windows[0]!.agents.push(
    { id: "agent-b", name: "sleep", cmd: ["sleep", "30"], cols: 80, rows: 24, exited: false, exitCode: null },
  )
  const adopted = workspaceFromSession(saved)
  const closed = applyWorkspaceCommand(adopted, command("pane.close"), context)
  const window = closed.snapshot.spaces[0]!.windows[0]!
  // The window has live agents (agent-a detached, agent-b detached).
  // afterPaneRemoved reveals the first live one.
  expect(window.layout.root).not.toBeNull()
  expect(window.state.focus).not.toBeNull()
})

test("space.new uses node path resolution and basename semantics", () => {
  const adopted = workspaceFromSession(base('{"version":1,"root":{"type":"pane","id":"pane-a","agent":"agent-a","weight":1},"focus":"pane-a"}'))
  const next = applyWorkspaceCommand(adopted, command("space.new", { dir: "./tmp/../portable-project" }), context).snapshot
  const created = next.spaces.at(-1)!
  expect(created.dir).toBe(resolve("./tmp/../portable-project"))
  expect(created.name).toBe("portable-project")
})
