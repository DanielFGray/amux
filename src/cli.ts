#!/usr/bin/env bun
/**
 * The single `amux` binary.
 *
 * Dispatches on the first argument to the four subcommands, each of which is
 * the already-existing main of its own module. Everything else — or nothing —
 * is a session id (default `default`) and takes the client path, which is why
 * `amux` pairs with only `bun run daemon <id>` to make a daemon-less terminal
 * feel like a foreground one. The client reads the chosen session from
 * `AMUX_SESSION`, the same variable `main.tsx` honours directly.
 */
import { isSessionId } from "./session.ts"

const [sub, id] = process.argv.slice(2)

if (sub === "help" || sub === "--help" || sub === "-h") {
  console.log(`usage: amux [session-id] | <daemon|status|stop> [session-id]

  amux [session-id]   attach to a session (autostarting its daemon); default
                       sessions is "default"
  amux daemon [id]     run the daemon for a session in the foreground
  amux status [id]     print a session's status as JSON
  amux stop [id]       stop a session`)
  process.exit(0)
}

if (sub === "daemon") {
  const { runDaemonMain } = await import("./daemon-main.ts")
  runDaemonMain(id)
} else if (sub === "status" || sub === "stop") {
  const { runSessionCli } = await import("./session-cli.ts")
  process.exit(await runSessionCli([sub, id ?? "default"]))
} else {
  const sessionId = sub ?? "default"
  if (!isSessionId(sessionId)) {
    console.error(`invalid session id ${JSON.stringify(sessionId)}`)
    process.exit(2)
  }
  process.env.AMUX_SESSION = sessionId
  await import("./main.tsx")
}