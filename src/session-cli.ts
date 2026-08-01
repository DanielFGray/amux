import { daemonRequest } from "./daemon.ts"

const [command, id = "default"] = process.argv.slice(2)
if (!command || !["status", "stop"].includes(command)) {
  console.error("usage: bun src/session-cli.ts <status|stop> [session-id]")
  process.exit(2)
}

try {
  const result = await daemonRequest(id, {
    command: command as "status" | "stop",
  })
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  process.exit(result.ok ? 0 : 1)
} catch (error) {
  console.error(`session '${id}' is unavailable: ${String(error)}`)
  process.exit(1)
}
