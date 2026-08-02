import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SessionDaemon } from "./daemon.ts"
import { cleanupStaleSessions, loadSession, sessionPaths, writeLease, SessionEnv } from "./session.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function env() {
  const home = await mkdtemp(join(tmpdir(), "herdr-daemon-"))
  dirs.push(home)
  return { HOME: home, XDG_STATE_HOME: join(home, "state") }
}

const run = <A>(effect: Effect.Effect<A, unknown, SessionEnv>, e: NodeJS.ProcessEnv) => Effect.runPromise(effect.pipe(Effect.provideService(SessionEnv, e)))
const open = (id: string, e: NodeJS.ProcessEnv) => run(SessionDaemon.open(id), e)
const paths = (id: string, e: NodeJS.ProcessEnv) => run(sessionPaths(id), e)

test("concurrent opens reject the second owner and release on stop", async () => {
  const e = await env()
  const first = await open("race", e)
  await expect(open("race", e)).rejects.toThrow("already being opened")
  await first.start()
  await expect(open("race", e)).rejects.toThrow(/already (being opened|owned)/)
  await first.stop()
  expect(await run(loadSession("race"), e)).toBeNull()
})

test("a dead lease and stale lock are recovered without deleting state", async () => {
  const e = await env()
  const paths = await run(sessionPaths("restart"), e)
  await Bun.write(paths.state, JSON.stringify({ version: 1, id: "restart", createdAt: 1, updatedAt: 1, attached: true, spaces: [] }))
  await writeFile(paths.lock, "999999\n")
  await run(writeLease({ version: 1, session: "restart", pid: 999999, socket: paths.socket, startedAt: 1, heartbeatAt: 1 }), e)
  const daemon = await open("restart", e)
  expect(daemon.state.id).toBe("restart")
  expect(daemon.state.attached).toBe(false)
  await daemon.stop()
})

test("cleanup leaves a locked startup session for its owner", async () => {
  const e = await env()
  const paths = await run(sessionPaths("starting"), e)
  await Bun.write(paths.state, JSON.stringify({ version: 1, id: "starting", createdAt: 1, updatedAt: 1, attached: false, spaces: [] }))
  await writeFile(paths.lock, `${process.pid}\n`)
  expect(await run(cleanupStaleSessions(), e)).toEqual([])
  expect(await run(loadSession("starting"), e)).not.toBeNull()
})

// The workspace is what makes a restart worth surviving: without it a restored
// session knows a shell was running and nothing about where it sat.
test("a saved workspace survives closing and reopening the daemon", async () => {
  const e = await env()
  const first = await open("workspace", e)
  await first.start()
  await first.saveWorkspace({
    activeSpace: "space-0",
    spaces: [
      {
        id: "space-0",
        name: "proj",
        dir: "/tmp",
        activeWindow: 2,
        windows: [
          {
            number: 2,
            name: "build",
            focusedAgent: "agent-1",
            layout: '{"version":1,"root":{"type":"pane","agent":"agent-1","weight":1}}',
            agents: [
              { id: "agent-1", name: "bash", cmd: ["bash"], cols: 80, rows: 24, exited: false, exitCode: null },
            ],
          },
        ],
      },
    ],
  })
  await first.close()

  const second = await open("workspace", e)
  const window = second.state.spaces[0]!.windows[0]!
  expect(second.state.activeSpace).toBe("space-0")
  expect(window.number).toBe(2)
  expect(window.layout).toContain("agent-1")
  // Reopening is not reattaching: a restart leaves nobody holding the session.
  expect(second.state.attached).toBe(false)
  await second.close()
})

// stop() is the deliberate end of a session, not a restart.
test("stopping a daemon discards the workspace it was keeping", async () => {
  const e = await env()
  const daemon = await open("discard", e)
  await daemon.start()
  await daemon.saveWorkspace({ spaces: [{ id: "space-0", name: "p", dir: "/tmp", activeWindow: null, windows: [] }] })
  await daemon.stop()
  expect(await run(loadSession("discard"), e)).toBeNull()
})
