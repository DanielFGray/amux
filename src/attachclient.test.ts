/**
 * The multiplexer property, end to end.
 *
 * Everything here goes through the real sockets: a real daemon, its real attach
 * stream, a real PTY, and a real Agent with a real terminal emulator on the
 * other end. That is deliberate — the whole value of the daemon is a behaviour
 * at the seams (an agent outliving the process that is showing it), and a test
 * that stubbed either end would prove nothing about it.
 */

import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "./agent.ts"
import { SessionClient, type SessionClientShape } from "./client.ts"
import { SessionDaemon } from "./daemon.ts"
import { captureVisible } from "./capture.ts"
import { MODE_ALT_SCREEN } from "./ghostty.ts"
import { processAlive, readLease, SessionEnv } from "./session.ts"

const dirs: string[] = []
const daemons: SessionDaemon[] = []
const clients: SessionClientShape[] = []
const agents: Agent[] = []
const run = <A>(effect: Effect.Effect<A, unknown, SessionEnv>, env: NodeJS.ProcessEnv) => Effect.runPromise(effect.pipe(Effect.provideService(SessionEnv, env)))

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.dispose()
  for (const client of clients.splice(0)) client.close()
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => {})
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function session(id: string) {
  const home = await mkdtemp(join(tmpdir(), "herdr-client-"))
  dirs.push(home)
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv
  const daemon = await run(SessionDaemon.open(id), env)
  daemons.push(daemon)
  await daemon.start()
  return { daemon, env }
}

/** Attach as a client of an already-running daemon. */
async function attach(id: string, env: NodeJS.ProcessEnv, client = "ui") {
  const connected = await run(SessionClient.connect(id, { client, autostart: false }), env)
  clients.push(connected)
  return connected
}

/** Wait for a predicate, so tests assert on outcomes rather than on sleeps. */
async function until(predicate: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** What the agent's terminal is actually showing, as text. The app's own
 *  capture path, so these assertions read the screen the user would. */
const screen = (agent: Agent) => captureVisible(agent.term)

test("an agent's bytes travel to the daemon and its output comes back", async () => {
  const { daemon, env } = await session("roundtrip")
  const client = await attach("roundtrip", env)

  const agent = new Agent({ cmd: ["cat"], backend: client.backend() })
  agents.push(agent)

  // The spawn is a round trip over RPC, so the first write has to be held until
  // the daemon actually has an agent by this name to give it to.
  agent.write("hello-from-the-client\n")
  await until(() => screen(agent).includes("hello-from-the-client"), "cat to echo the input")

  // And the daemon, not this process, is the one holding the PTY.
  expect(await daemon.liveAgents()).toContain(agent.id)
})

test("two clients share output and input, and one can leave without detaching the other", async () => {
  const { daemon, env } = await session("shared-attach")
  const first = await attach("shared-attach", env, "first")
  const second = await attach("shared-attach", env, "second")

  const firstAgent = new Agent({ cmd: ["cat"], backend: first.backend() })
  const secondAgent = new Agent({ id: firstAgent.id, cmd: ["cat"], backend: second.backend() })
  agents.push(firstAgent, secondAgent)

  firstAgent.write("first-input\n")
  await until(() => screen(firstAgent).includes("first-input") && screen(secondAgent).includes("first-input"), "both clients to see first input")
  secondAgent.write("second-input\n")
  await until(() => screen(firstAgent).includes("second-input") && screen(secondAgent).includes("second-input"), "both clients to see second input")

  // The second adoption is targeted replay, not a broadcast: it receives the
  // existing screen while the first client's view remains live and unchanged.
  expect(screen(secondAgent)).toContain("first-input")
  first.close()
  // Wait for the daemon to actually PROCESS the EOF, not merely for `attached`
  // to be true — it was already true before the close, so waiting on it would
  // return instantly and prove nothing about the release path.
  await until(() => daemon.attachedClients.length === 1, "the daemon to notice the first client leave")
  expect(daemon.attachedClients).toEqual(["second"])

  secondAgent.write("still-shared\n")
  await until(() => screen(secondAgent).includes("still-shared"), "the remaining client to keep working")
  expect((await daemon.handle({ command: "ping" })).attached).toBe(true)
})

test("an agent outlives the client, and the next client adopts it", async () => {
  const { daemon, env } = await session("outlives")
  const first = await attach("outlives", env)

  const agent = new Agent({ cmd: ["cat"], backend: first.backend() })
  agents.push(agent)
  let exited = false
  agent.onExit = () => { exited = true }
  agent.write("first-life\n")
  await until(() => screen(agent).includes("first-life"), "the first client's echo")

  // Detach, exactly as closing the terminal would.
  first.close()
  await until(() => daemon.attachedClient === null, "the daemon to notice the detach")
  expect(await daemon.liveAgents()).toContain(agent.id)

  // The backend closed with no exit code: the attachment ended, the process
  // did not. Reporting 0 here would be a lie the sidebar renders as "done".
  await until(() => agent.detached, "the detached backend to close")
  expect(agent.exited).toBe(false)
  expect(exited).toBe(false)
  expect(agent.exitCode).toBeNull()
  expect(agent.detached).toBe(true)
  expect(agent.state).toBe("idle")

  const second = await attach("outlives", env)
  expect(second.live).toContain(agent.id)

  // Adopted under the same id: nothing was re-run, so the same `cat` is still
  // there to answer. A fresh spawn would also echo, which is why the assertion
  // below is about the daemon's agent list and not just about the echo.
  const readopted = new Agent({ id: agent.id, cmd: ["cat"], backend: second.backend() })
  agents.push(readopted)
  readopted.write("second-life\n")
  await until(() => screen(readopted).includes("second-life"), "the adopted agent's echo")
  expect((await daemon.liveAgents()).filter((id) => id === agent.id)).toHaveLength(1)
})

test("a process that ends reports its exit code through the stream", async () => {
  const { env } = await session("exits")
  const client = await attach("exits", env)

  const agent = new Agent({ cmd: ["sh", "-c", "exit 7"], backend: client.backend() })
  agents.push(agent)

  await until(() => agent.exited, "the agent to exit")
  expect(agent.detached).toBe(false)
  expect(agent.state).toBe("done")
  expect(agent.exitCode).toBe(7)
})

test("output written immediately before exit arrives before the exit frame", async () => {
  const { env } = await session("drain-order")
  const client = await attach("drain-order", env)

  const agent = new Agent({
    cmd: ["sh", "-c", "printf 'last-bytes\\n'; exit 9"],
    backend: client.backend(),
  })
  agents.push(agent)

  await until(() => agent.exited, "the short-lived agent to exit")
  expect(screen(agent)).toContain("last-bytes")
  expect(agent.exitCode).toBe(9)
})

test("killing through the daemon ends the agent here too", async () => {
  const { daemon, env } = await session("killed")
  const client = await attach("killed", env)

  const agent = new Agent({ cmd: ["sleep", "30"], backend: client.backend() })
  agents.push(agent)

  let live: readonly string[] = []
  await until(
    () => {
      void daemon.liveAgents().then((ids) => (live = ids))
      return live.includes(agent.id)
    },
    "the daemon to have the agent",
  )

  // kill() is issued here and executed there; it must still end this agent's
  // stream, because the exit frame travels back the same way output does.
  agent.kill()
  await until(() => agent.exited, "the killed agent to close")
})

test("a command that does not exist fails in the daemon and is visible here", async () => {
  const { env } = await session("missing-command")
  const client = await attach("missing-command", env)

  // The daemon spawns this happily — a PTY for a program that is not there is
  // still a PTY. The failure arrives as output and an exit, like any other
  // process that could not do its job, which is what a terminal should show.
  const agent = new Agent({ cmd: ["/definitely/not/a/program"], backend: client.backend() })
  agents.push(agent)

  await until(() => agent.exited, "the failed command to exit")
  expect(screen(agent)).toContain("No such file or directory")
  expect(agent.exitCode).toBeGreaterThan(0)
})

test("a spawn the daemon never receives becomes a dead agent, not a hung one", async () => {
  const { daemon, env } = await session("unreachable")
  const client = await attach("unreachable", env)

  // The daemon goes away between attaching and spawning. Nothing can start, so
  // the agent must fail loudly rather than sit forever waiting for first bytes.
  await daemon.stop()
  daemons.splice(daemons.indexOf(daemon), 1)

  const agent = new Agent({ cmd: ["cat"], backend: client.backend() })
  agents.push(agent)

  await until(() => agent.exited, "the failed spawn to close the agent")
  expect(screen(agent)).toContain("could not start")
})

test("a client whose daemon stops sees a detach, not a process exit", async () => {
  const { daemon, env } = await session("daemon-dies")
  const client = await attach("daemon-dies", env)

  const agent = new Agent({ cmd: ["cat"], backend: client.backend() })
  agents.push(agent)
  agent.write("before-death\n")
  await until(() => screen(agent).includes("before-death"), "the client's echo")

  // Explicit stop ends the daemon, its socket and its agents in one move. No
  // exit frame is in flight, so the client learns about it the same way it
  // would learn about a crash — as an attachment ending, never as a clean
  // exit. A stop and a crash only diverge on the next RPC: stop removed the
  // session, a crash left it restorable.
  await daemon.stop()
  daemons.splice(daemons.indexOf(daemon), 1)

  await until(() => agent.detached, "the client to notice the daemon went away")
  expect(agent.exited).toBe(false)
  expect(agent.exitCode).toBeNull()
  expect(agent.state).toBe("idle")
})

test("a reattaching client sees an adopted agent's screen without it redrawing", async () => {
  const { daemon, env } = await session("replay-screen")
  const first = await attach("replay-screen", env)

  const agent = new Agent({ cmd: ["cat"], backend: first.backend() })
  agents.push(agent)
  agent.write("left-on-screen\n")
  await until(() => screen(agent).includes("left-on-screen"), "the first client's echo")

  first.close()
  await until(() => daemon.attachedClient === null, "the daemon to notice the detach")

  const second = await attach("replay-screen", env)
  const readopted = new Agent({ id: agent.id, cmd: ["cat"], backend: second.backend() })
  agents.push(readopted)

  // cat never redraws. The old line can reach this fresh pane only through the
  // daemon's replay; without it the pane stays blank until some later echo.
  await until(() => screen(readopted).includes("left-on-screen"), "the replayed screen")
  expect(await daemon.liveAgents()).toContain(agent.id)
})

test("an alternate-screen app's view is replayed intact to a reattaching client", async () => {
  const { daemon, env } = await session("replay-alt")
  const first = await attach("replay-alt", env)

  const cmd = ["sh", "-c", "printf '\\033[?1049h\\033[2J\\033[2;2Halt-mode-view'; sleep 30"]
  const agent = new Agent({ cmd, backend: first.backend() })
  agents.push(agent)
  await until(() => screen(agent).includes("alt-mode-view"), "the app to draw its alternate screen")
  expect(agent.term.mode(MODE_ALT_SCREEN)).toBe(true)

  first.close()
  await until(() => daemon.attachedClient === null, "the daemon to notice the detach")

  const second = await attach("replay-alt", env)
  const readopted = new Agent({ id: agent.id, cmd, backend: second.backend() })
  agents.push(readopted)

  // The content alone could have landed on the wrong screen; the mode check is
  // the discriminator. A raw byte-suffix replay would fail exactly here.
  await until(() => screen(readopted).includes("alt-mode-view"), "the replayed alternate screen")
  expect(readopted.term.mode(MODE_ALT_SCREEN)).toBe(true)
})

/**
 * The real deployment path: a daemon in its own process, started on demand.
 *
 * Every other test here hosts the daemon in the test process, which is the
 * right trade for exercising behaviour but leaves the one claim that matters
 * most unproven — that the agents are in a process that does not go away when
 * this one does. Here the daemon is a separate pid, and the client attaching
 * the second time is a genuine reattach.
 */
test("a daemon started on demand keeps agents between two separate clients", async () => {
  const home = await mkdtemp(join(tmpdir(), "herdr-autostart-"))
  dirs.push(home)
  // A real environment, plus a private state root: the daemon has to spawn
  // programs, and a PATH-less env would fail for reasons that have nothing to
  // do with what is under test.
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state") }
  const id = "autostart"

  const first = await run(SessionClient.connect(id, { client: "first" }), env)
  try {
    const lease = await run(readLease(id), env)
    expect(lease?.pid).toBeGreaterThan(0)
    expect(lease!.pid).not.toBe(process.pid)

    const agent = new Agent({ cmd: ["cat"], backend: first.backend() })
    agents.push(agent)
    agent.write("across-processes\n")
    await until(() => screen(agent).includes("across-processes"), "the daemon's echo")
    first.close()

    // A second client, with no memory of the first, finds the agent still there.
    const second = await run(SessionClient.connect(id, { client: "second" }), env)
    expect(second.live).toContain(agent.id)
    const readopted = new Agent({ id: agent.id, cmd: ["cat"], backend: second.backend() })
    agents.push(readopted)
    readopted.write("still-alive\n")
    await until(() => screen(readopted).includes("still-alive"), "the adopted agent's echo")
    await run(second.stop(), env)
  } finally {
    const lease = await run(readLease(id), env)
    if (lease && processAlive(lease.pid)) process.kill(lease.pid, "SIGKILL")
  }
})

test("a workspace saved through the daemon is visible to a later client", async () => {
  const { daemon, env } = await session("saved")
  const client = await attach("saved", env)

  await run(client.save({
    spaces: [{ id: "space-1", name: "proj", dir: "/tmp", activeWindow: 1, windows: [] }],
    activeSpace: "space-1",
  }), env)

  // And a client attaching later is handed that same workspace to rebuild from.
  client.close()
  const next = await attach("saved", env, "second")
  expect(next.session?.spaces.map((s) => s.name)).toEqual(["proj"])
})
