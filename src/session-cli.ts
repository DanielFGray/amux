import { daemonRequest } from "./daemon.ts";
import { isSessionId, SessionEnv } from "./session.ts";
import { Effect } from "effect";

/** `amux status <id>` / `amux stop <id>`: a one-shot RPC against a live daemon. */
export async function runSessionCli(argv: string[]): Promise<number> {
  const [command, id = "default"] = argv;
  if (!command || !["status", "stop"].includes(command)) {
    console.error("usage: amux <status|stop> [session-id]");
    return 2;
  }
  if (!isSessionId(id)) {
    console.error(`invalid session id ${JSON.stringify(id)}`);
    return 2;
  }

  try {
    const result = await Effect.runPromise(
      daemonRequest(id, {
        command: command as "status" | "stop",
      }).pipe(Effect.provideService(SessionEnv, process.env)),
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`session '${id}' is unavailable: ${String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runSessionCli(process.argv.slice(2)));
