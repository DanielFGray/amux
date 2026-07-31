import { daemonRequest } from "./daemon.ts"

const [command, id = "default", client] = process.argv.slice(2)
if (!command || !["attach", "detach", "status", "stop"].includes(command)) {
  console.error("usage: bun src/session-cli.ts <attach|detach|status|stop> [session-id] [client-id]")
  process.exit(2)
}
if ((command === "attach" || command === "detach") && !client) {
  console.error("attach and detach require a stable client-id")
  process.exit(2)
}

try {
  const result = await daemonRequest(id, {
    command: command as "attach" | "detach" | "status" | "stop",
    ...(command === "attach" || command === "detach" ? { client } : {}),
  })
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  process.exit(result.ok ? 0 : 1)
} catch (error) {
  console.error(`session '${id}' is unavailable: ${String(error)}`)
  process.exit(1)
}
