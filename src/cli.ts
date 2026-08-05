#!/usr/bin/env bun
/**
 * The single `amux` binary.
 *
 * Dispatches on the first argument:
 * - `amux [session-id]` — attach to a session (autostart daemon)
 * - `amux daemon [id]` — run the daemon foreground
 * - `amux status|stop [id]` — one-shot RPC lifecycle commands
 * - `amux <command> [args]` — invoke a remote command via the daemon RPC
 * - `amux help` — show usage
 */
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { Session, SessionEnv, isSessionId } from "./session.ts";
import { daemonRequest } from "./daemon.ts";
import { command, COMMAND_META, decodeCommand, type CommandTag } from "./commands.ts";
import { parseArgs, generateHelp } from "./command-cli.ts";

function isCommandTag(s: string): s is CommandTag {
  return s in COMMAND_META;
}

const runRpc = (id: string, body: unknown) =>
  daemonRequest(id, body as any).pipe(
    Effect.provide(Session.Default),
    Effect.provide(BunFileSystem.layer),
    Effect.provideService(SessionEnv, process.env),
  );

async function runCommand(id: string, tag: CommandTag, argv: string[]): Promise<number> {
  const { parsed, errors } = parseArgs(tag, argv);
  if (errors.length > 0) {
    console.error(`error: ${errors.join("\n  ")}`);
    return 2;
  }
  if (!parsed) {
    console.error(`error: could not parse arguments for '${tag}'`);
    return 2;
  }

  const meta = COMMAND_META[tag]!;
  if (!parsed) return 2;

  try {
    const cmdVal = { _tag: tag, ...parsed };
    const result = await Effect.runPromise(
      runRpc(id, {
        command: "run",
        commandValue: cmdVal,
      }),
    );

    if (!result.ok) {
      console.error(`error: ${result.error ?? "command refused"}`);
      return 1;
    }

    if (result.result !== undefined) {
      if (typeof result.result === "object")
        process.stdout.write(JSON.stringify(result.result, null, 2) + "\n");
      else process.stdout.write(String(result.result) + "\n");
    }

    if (result.workspace) {
      // workspace-targeted commands return the new workspace snapshot too
    }

    return 0;
  } catch (error) {
    console.error(`error: ${String(error)}`);
    return 1;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    if (sub === "--help" || sub === "-h" || !sub) {
      process.stdout.write(generateHelp() + "\n");
      return 0;
    }
    return 1;
  }

  // Legacy commands
  if (sub === "daemon") {
    const { runDaemonMain } = await import("./daemon-main.ts");
    runDaemonMain(argv[1]);
    return 0;
  }

  if (sub === "status" || sub === "stop") {
    const { runSessionCli } = await import("./session-cli.ts");
    return await runSessionCli([sub, argv[1] ?? "default"]);
  }

  // Command dispatch
  if (isCommandTag(sub)) {
    const id = argv[1] && isSessionId(argv[1]) ? argv[1] : "default";
    const cmdArgs = argv[1] && isSessionId(argv[1]) ? argv.slice(2) : argv.slice(1);
    return await runCommand(id, sub as CommandTag, cmdArgs);
  }

  // Session attach (default)
  const sessionId = sub;
  if (!isSessionId(sessionId)) {
    console.error(`unknown command or invalid session id: ${JSON.stringify(sessionId)}`);
    return 2;
  }
  process.env.AMUX_SESSION = sessionId;
  await import("./main.tsx");
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exitCode = code);
}
