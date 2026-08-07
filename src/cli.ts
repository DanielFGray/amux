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
import { Effect, Schema } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { Session, isSessionId } from "./session.ts";
import { controlCall } from "./control-client.ts";
import { COMMAND_META, Command, type CommandTag } from "./commands.ts";
import { parseArgs, generateHelp } from "./command-cli.ts";

function isCommandTag(s: string): s is CommandTag {
  return s in COMMAND_META;
}

const runRpc = (id: string, value: Command) =>
  controlCall(id, (control) => control.Run({ value })).pipe(
    Effect.provide(Session.Default),
    Effect.provide(BunFileSystem.layer),
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
    const value = Schema.decodeUnknownSync(Command)({ _tag: tag, ...parsed });
    const { result } = await Effect.runPromise(runRpc(id, value));

    if (result !== undefined) {
      if (typeof result === "object") process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      else process.stdout.write(String(result) + "\n");
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
  main().then((code) => (process.exitCode = code));
}
