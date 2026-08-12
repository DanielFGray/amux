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
 *
 * Static imports are deliberately absent: Bun evaluates them before main() runs,
 * so this file has none. Every subcommand lazy-loads only what it needs, keeping
 * `--help`, `agent-state`, and `agent-hook` sub-millisecond.
 */
import { HELP_TEXT } from "./command-help.ts";

export function splitCommandArgs(argv: readonly string[]): string[][] {
  const groups: string[][] = [[]];
  for (const arg of argv) {
    if (arg === ";") groups.push([]);
    else groups.at(-1)!.push(arg);
  }
  return groups;
}

/**
 * Resolve the daemon session id for a command invocation.
 *
 * Accepts the target string directly (not a CommandTag) so this
 * file avoids importing the full commands module.
 */
export function resolveCommandSession(
  target: string,
  positionalSession: string | undefined,
  parsed: Record<string, unknown>,
): string | null {
  if (typeof parsed.session === "string") return parsed.session;
  if (positionalSession) return positionalSession;
  const fromPane = process.env.AMUX_DAEMON_SESSION;
  if (fromPane) return fromPane;
  return target === "session" ? null : "default";
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP_TEXT + "\n");
    return 0;
  }

  if (sub === "daemon") {
    const { runDaemonMain } = await import("./daemon-main.ts");
    runDaemonMain(argv[1]);
    return 0;
  }

  if (sub === "status" || sub === "stop") {
    const { runSessionCli } = await import("./session-cli.ts");
    return await runSessionCli([sub, argv[1] ?? "default"]);
  }

  if (sub === "agent-state") {
    return await (async () => {
      const state =
        argv.find((v) => v.startsWith("--state="))?.slice(8) ??
        (argv.includes("--state") ? argv[argv.indexOf("--state") + 1] : undefined);
      const socketPath = process.env.AMUX_AGENT_STATE_SOCKET;
      const agent = process.env.AMUX_PANE_ID;
      if (!socketPath || !agent) {
        console.error("error: 'agent-state' requires a managed pane");
        return 2;
      }
      const { isReportedAgentState, reportAgentState, ReportedAgentStateSchema } =
        await import("./agent-state.ts");
      if (!isReportedAgentState(state)) {
        console.error(
          `error: --state must be one of ${ReportedAgentStateSchema.literals.join(", ")}`,
        );
        return 2;
      }
      try {
        await reportAgentState(socketPath, agent, state);
        return 0;
      } catch (error) {
        console.error(`error: ${String(error)}`);
        return 1;
      }
    })();
  }

  if (sub === "agent-hook") {
    return await (async () => {
      const { installOpencodeHook, uninstallOpencodeHook } = await import("./agent-hook.ts");
      const [vendor, action] = argv.slice(1);
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
    })();
  }

  // Command dispatch — needs Effect, control-client, commands, etc.
  const [effectMod, { SessionStore, isSessionId }, { controlCall, agentWatch }, commandsMod, { parseArgs }] =
    await Promise.all([
      import("effect"),
      import("./session.ts"),
      import("./control-client.ts"),
      import("./commands.ts"),
      import("./command-cli.ts"),
    ]);
  const { Effect, Option, Schema, Stream } = effectMod;
  const { COMMAND_META, Command, commandDefinition } = commandsMod;
  type CommandTag = (typeof Command.Type)["_tag"];

  function isCommandTag(s: string): s is CommandTag {
    return s in COMMAND_META;
  }

  function parseCommandGroup(argv: string[]):
    | { tag: CommandTag; parsed: Record<string, unknown>; positionalSession?: string }
    | { errors: string[] } {
    const tag = argv[0];
    if (!tag || !isCommandTag(tag))
      return { errors: [`unknown command: ${JSON.stringify(tag ?? "")}`] };

    const direct = parseArgs(tag, argv.slice(1));
    if (direct.parsed) return { tag, parsed: direct.parsed };

    const positionalSession = argv[1];
    if (positionalSession && isSessionId(positionalSession)) {
      const legacy = parseArgs(tag, argv.slice(2));
      if (legacy.parsed) return { tag, parsed: legacy.parsed, positionalSession };
    }
    return { errors: direct.errors };
  }

  if (isCommandTag(sub)) {
    const groups = splitCommandArgs(argv);
    const cmds: (typeof Command.Type)[] = [];
    let id: string | undefined;
    for (const group of groups) {
      const parsed = parseCommandGroup(group);
      if ("errors" in parsed) {
        console.error(`error: ${parsed.errors.join("\n  ")}`);
        return 2;
      }
      const targetId: string | null = resolveCommandSession(
        commandDefinition(parsed.tag).target,
        parsed.positionalSession,
        parsed.parsed,
      );
      if (!targetId) {
        console.error(`error: '${parsed.tag}' requires a session id or a managed pane`);
        return 2;
      }
      if (id !== undefined && targetId !== id) {
        console.error("error: chained commands must target the same daemon session");
        return 2;
      }
      id = targetId;
      cmds.push(Schema.decodeUnknownSync(Command)({ _tag: parsed.tag, ...parsed.parsed }));
    }

    const { BunFileSystem } = await import("@effect/platform-bun");
    const prompt = cmds.length === 1 && cmds[0]?._tag === "agent.prompt" ? cmds[0] : undefined;
    const watch = cmds.length === 1 && cmds[0]?._tag === "agent.watch" ? cmds[0] : undefined;
    if (watch) {
      try {
        await Effect.runPromise(
          controlCall(id!, (control) =>
            agentWatch(control, watch.target, watch.after).pipe(
              Stream.runForEach((event) => Effect.sync(() => process.stdout.write(JSON.stringify(event) + "\n"))),
            ),
          ).pipe(Effect.provide(SessionStore.Default), Effect.provide(BunFileSystem.layer)),
        );
        return 0;
      } catch (error) {
        console.error(`error: ${String(error)}`);
        return 1;
      }
    }
    const runResult = Effect.runPromise(
      controlCall(id!, (control) => {
        const context = {
          size: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
          shell: [process.env.SHELL ?? "sh"],
          cwd: process.cwd(),
        };
        if (!prompt || (prompt.wait !== true && prompt.until === undefined))
          return control.Batch({ values: [...cmds], context });

        return Effect.gen(function* () {
          const after = yield* control.AgentCursor({ session: prompt.target });
          const { outputs } = yield* control.Batch({ values: [...cmds], context });
          const timeout = prompt.timeout ?? 30000;
          const deadline = Date.now() + timeout;
          const first = yield* agentWatch(control, prompt.target, after).pipe(
            Stream.filter(
              (event): event is any => event._tag === "turn.start" || event._tag === "agent.status",
            ),
            Stream.runHead,
            Effect.timeoutFail({
              duration: Math.min(5000, timeout),
              onTimeout: () => new Error("agent_prompt_stalled"),
            }),
          );
          if (Option.isNone(first)) return { outputs: [...outputs, { result: { error: "agent_prompt_stalled" } }] };
          let turn: string | undefined;
          let result: unknown;
          const fold = (event: any) => {
            if (event._tag === "turn.start" && turn === undefined) turn = event.turn;
            if (event._tag === "turn.end" && event.turn === turn) {
              result = event;
              return true;
            }
            if (
              prompt.until !== undefined &&
              event._tag === "agent.status" &&
              event.state === prompt.until
            ) {
              result = event;
              return true;
            }
            return false;
          };
          if (!fold(first.value))
            yield* agentWatch(control, prompt.target, first.value.sequence).pipe(
              Stream.takeUntil((event) => {
                return fold(event);
              }),
              Stream.runDrain,
              Effect.timeoutFail({
                duration: Math.max(0, deadline - Date.now()),
                onTimeout: () => new Error("agent_wait_timeout"),
              }),
            );
          return { outputs: [...outputs, { result: result ?? { turn } }] };
        });
      }).pipe(Effect.provide(SessionStore.Default), Effect.provide(BunFileSystem.layer)),
    );

    try {
      const { outputs } = await runResult;
      for (const { result } of outputs) {
        if (result !== undefined) {
          if (typeof result === "object")
            process.stdout.write(JSON.stringify(result, null, 2) + "\n");
          else process.stdout.write(String(result) + "\n");
        }
      }
      return 0;
    } catch (error) {
      console.error(`error: ${String(error)}`);
      return 1;
    }
  }

  // Session attach
  if (!isSessionId(sub)) {
    console.error(`unknown command or invalid session id: ${JSON.stringify(sub)}`);
    return 2;
  }
  process.env.AMUX_SESSION = sub;
  await import("./main.tsx");
  return 0;
}

if (import.meta.main) {
  main().then((code) => (process.exitCode = code));
}
