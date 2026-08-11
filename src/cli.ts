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
import { SessionStore, isSessionId } from "./session.ts";
import { controlCall } from "./control-client.ts";
import { commandDefinition, COMMAND_META, Command, type CommandTag } from "./commands.ts";
import { parseArgs, generateHelp } from "./command-cli.ts";
import { isReportedAgentState, reportAgentState, ReportedAgentState } from "./agent-state.ts";
import { installOpencodeHook, uninstallOpencodeHook } from "./agent-hook.ts";

function isCommandTag(s: string): s is CommandTag {
  return s in COMMAND_META;
}

const runRpc = (id: string, value: Command) =>
  controlCall(id, (control) => control.Run({ value })).pipe(
    Effect.provide(SessionStore.Default),
    Effect.provide(BunFileSystem.layer),
  );

async function runCommand(
  id: string,
  tag: CommandTag,
  parsed: Record<string, unknown>,
): Promise<number> {
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

export function resolveCommandSession(
  tag: CommandTag,
  positionalSession: string | undefined,
  parsed: Record<string, unknown>,
): string | null {
  if (typeof parsed.session === "string") return parsed.session;
  if (positionalSession) return positionalSession;
  const fromPane = process.env.AMUX_DAEMON_SESSION;
  if (fromPane) return fromPane;
  return commandDefinition(tag).target === "session" ? null : "default";
}

async function runAgentState(argv: string[]): Promise<number> {
  const state =
    argv.find((value) => value.startsWith("--state="))?.slice(8) ??
    (argv.includes("--state") ? argv[argv.indexOf("--state") + 1] : undefined);
  // The same two-variable contract the installed hooks read: a pane that can be
  // reported on is a pane that was told its own id and where to write.
  const socketPath = process.env.AMUX_AGENT_STATE_SOCKET;
  const agent = process.env.AMUX_PANE_ID;
  if (!socketPath || !agent) {
    console.error("error: 'agent-state' requires a managed pane");
    return 2;
  }
  if (!isReportedAgentState(state)) {
    console.error(`error: --state must be one of ${ReportedAgentState.literals.join(", ")}`);
    return 2;
  }
  try {
    await reportAgentState(socketPath, agent, state);
    return 0;
  } catch (error) {
    console.error(`error: ${String(error)}`);
    return 1;
  }
}

async function runAgentHook(argv: string[]): Promise<number> {
  const [vendor, action] = argv;
  if (vendor !== "opencode" || (action !== "install" && action !== "uninstall")) {
    console.error("usage: amux agent-hook opencode <install|uninstall> --yes");
    return 2;
  }
  if (!argv.includes("--yes")) {
    console.error("error: editing opencode config requires explicit consent; add --yes");
    return 2;
  }
  try {
    if (action === "install") {
      console.log(`installed opencode hook at ${await installOpencodeHook()}`);
    } else {
      const removed = await uninstallOpencodeHook();
      console.log(removed ? "removed opencode hook" : "no opencode hook installed");
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

  if (sub === "agent-state") return await runAgentState(argv.slice(1));
  if (sub === "agent-hook") return await runAgentHook(argv.slice(1));

  // Command dispatch
  if (isCommandTag(sub)) {
    const positionalSession =
      argv[1] && !argv[1].startsWith("--") && isSessionId(argv[1]) ? argv[1] : undefined;
    const cmdArgs = positionalSession ? argv.slice(2) : argv.slice(1);
    const { parsed, errors } = parseArgs(sub, cmdArgs);
    if (errors.length > 0) {
      console.error(`error: ${errors.join("\n  ")}`);
      return 2;
    }
    if (!parsed) {
      console.error(`error: could not parse arguments for '${sub}'`);
      return 2;
    }
    const id = resolveCommandSession(sub, positionalSession, parsed);
    if (!id) {
      console.error(`error: '${sub}' requires a session id or a managed pane`);
      return 2;
    }
    return await runCommand(id, sub, parsed);
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
