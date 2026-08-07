import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { controlCall, type ControlClient } from "./control-client.ts";
import { isSessionId, Session } from "./session.ts";
import { parseWorkspaceJson } from "./workspace.ts";

/** `amux status <id>` / `amux stop <id>`: a one-shot RPC against a live daemon. */
export async function runSessionCli(argv: string[]): Promise<number> {
  const [verb, id = "default"] = argv;
  if (!verb || !["status", "stop"].includes(verb)) {
    console.error("usage: amux <status|stop> [session-id]");
    return 2;
  }
  if (!isSessionId(id)) {
    console.error(`invalid session id ${JSON.stringify(id)}`);
    return 2;
  }

  const call = <A, E>(use: (control: ControlClient) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      controlCall(id, use).pipe(
        Effect.provide(Session.Default),
        Effect.provide(BunFileSystem.layer),
      ),
    );

  try {
    if (verb === "stop") {
      await call((control) => control.Stop());
      process.stdout.write(JSON.stringify({ stopped: true }, null, 2) + "\n");
      return 0;
    }
    const { workspace, ...rest } = await call((control) => control.Status());
    const parsed = Effect.runSync(parseWorkspaceJson(workspace));
    const report = { ...rest, workspace: parsed };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.degraded === undefined ? 0 : 1;
  } catch (error) {
    console.error(`session '${id}' is unavailable: ${String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runSessionCli(process.argv.slice(2)));
