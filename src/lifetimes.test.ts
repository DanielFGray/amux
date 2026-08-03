/**
 * The scope chain actually releases.
 *
 * Phase 5b (ts-95af71) made SpaceSet, Space and Window scoped, so closing one
 * scope at the top is what ends every PTY underneath. Nothing asserted that.
 * The rest of the suite is about geometry and layout, and it passes just as
 * happily when teardown is a no-op — verified by mutation: deleting the release
 * loop from `SpaceSet.release` left all 339 tests green.
 *
 * These tests hold the chain to its promise at each link, with a backend that
 * records being killed rather than by inspecting processes: the property under
 * test is "the finalizer ran", and a spy says that directly.
 */
import { test, expect } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, Exit, Scope, Stream } from "effect"
import { SpaceSet } from "./space.ts"
import { workspaceEnv } from "./env.ts"
import type { SpawnBackend } from "./backend.ts"
import { run, runAsync } from "./harness.ts"

/**
 * A backend that starts nothing and remembers WHICH agents were killed.
 *
 * By id, not by count. A count cannot tell "killed the agent you asked for"
 * from "killed a different one instead" — and that is a real mutation: making
 * `killAgent` release every agent in the window still leaves the count at one
 * once the target has already been spliced out of the list.
 */
function spyBackend(): { backend: SpawnBackend; killed: () => string[] } {
  const killed: string[] = []
  const backend: SpawnBackend = (opts) => {
    // Per instance, not shared: `closed` describes THIS backend, while the
    // counter above is how many of them the release chain reached.
    let mine = false
    return {
      // Never ends on its own, so a killed backend is the only way the agent's
      // pump fiber stops — which is what makes the interrupt observable.
      stream: Stream.never,
      write() {},
      resize() {},
      close() {
        if (mine) return
        mine = true
        killed.push(opts.id)
      },
      kill() { this.close() },
      get closed() {
        return mine
      },
      detached: false,
      exitCode: null,
      foregroundPgid: () => -1,
      sessionId: () => -1,
    }
  }
  return { backend, killed: () => killed }
}

async function fixture() {
  const t = await createTestRenderer({ width: 60, height: 20 })
  const host = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 })
  t.renderer.root.add(host)
  const spy = spyBackend()
  const scope = Effect.runSync(Scope.make())
  const spaces = run(
    Scope.extend(
      SpaceSet.make(workspaceEnv(t.renderer, { backend: spy.backend }), host),
      scope,
    ),
  )
  return {
    spaces,
    killed: spy.killed,
    closeTop: () => runAsync(Scope.close(scope, Exit.void)),
    async cleanup() {
      await runAsync(Scope.close(scope, Exit.void))
      await Bun.sleep(20)
      t.renderer.destroy()
    },
  }
}

test("closing the top scope kills agents three levels down", async () => {
  const f = await fixture()
  try {
    const space = run(f.spaces.create("proj", process.cwd()))
    const window = run(space.newWindow())
    const first = run(window.init()).agent
    const second = run(window.spawn("second"))
    expect(f.killed()).toEqual([])

    await f.closeTop()
    // Both agents, reached through SpaceSet -> Space -> Window without anyone
    // calling a dispose method by hand.
    expect(f.killed().sort()).toEqual([first.id, second.id].sort())
  } finally {
    await f.cleanup()
  }
})

test("closing one window releases its agents and leaves its siblings running", async () => {
  const f = await fixture()
  try {
    const space = run(f.spaces.create("proj", process.cwd()))
    const doomed = run(space.newWindow())
    const doomedAgent = run(doomed.init()).agent
    const survivor = run(space.newWindow())
    const survivorAgent = run(survivor.init()).agent

    await runAsync(space.closeWindow(doomed))
    expect(f.killed()).toEqual([doomedAgent.id])

    // The survivor is still live: closing the top scope is what ends it.
    await f.closeTop()
    expect(f.killed()).toEqual([doomedAgent.id, survivorAgent.id])
  } finally {
    await f.cleanup()
  }
})

test("killAgent releases the agent it was given and no other", async () => {
  const f = await fixture()
  try {
    const space = run(f.spaces.create("proj", process.cwd()))
    const window = run(space.newWindow())
    const bystander = run(window.init()).agent
    const second = run(window.spawn("second"))

    await runAsync(window.killAgent(second))
    // By id: the target, not merely "one of them". killAgent splices its target
    // out of #agents before releasing, so a release loop over the survivors
    // would kill the bystander and still leave the count at one.
    expect(f.killed()).toEqual([second.id])
    expect(window.agents).toContain(bystander)
  } finally {
    await f.cleanup()
  }
})

test("a broken-out pane survives its source window closing", async () => {
  const f = await fixture()
  try {
    const space = run(f.spaces.create("proj", process.cwd()))
    const source = run(space.newWindow())
    const pane = run(source.init())
    const moved = pane.agent

    // breakPane moves the agent AND its scope. The source window is emptied and
    // closed by the break itself, so if the scope had stayed behind — or been
    // forked from the source window's — this would kill the process that just
    // moved out.
    const broken = await runAsync(space.breakPane(pane))
    expect(broken).not.toBeNull()
    expect(f.killed()).toEqual([])

    // And it is genuinely owned by its new window, not merely un-killed: the
    // scope travelled, so the destination is what closes it.
    await runAsync(space.closeWindow(broken!))
    expect(f.killed()).toEqual([moved.id])
  } finally {
    await f.cleanup()
  }
})
