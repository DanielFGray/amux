#!/usr/bin/env bun
/**
 * The single `amux` binary.
 *
 * Dispatches on the first argument:
 * - `amux [session-id]` — attach to an existing session
 * - `amux new <session-id>` — create (or resume) a session and attach
 * - `amux daemon [id]` — run the daemon foreground
 * - `amux status|stop|list [id]` — one-shot lifecycle commands
 * - `amux <command> [args]` — invoke a remote command via the daemon RPC
 * - `amux help` — show usage
 *
 * `amux <session-id>` never creates: a name that has no session directory
 * yet is refused rather than silently spun up, because a session id doubles
 * as a fallback for any unrecognized first argument — a mistyped command
 * would otherwise create and attach a throwaway session instead of erroring.
 * `amux new` is the one spelling that is allowed to create.
 *
 * Static imports are deliberately absent: Bun evaluates them before main() runs,
 * so this file has none. Every subcommand lazy-loads only what it needs, keeping
 * `process-state`, and `agent-hook` sub-millisecond.
 */
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
 * `--session` is a CLI-level flag: it selects the daemon, never a command
 * argument. The legacy `amux <command> <session-id> <args>` form is the
 * positional fallback. Accepts the target string directly (not a CommandTag)
 * so this file avoids importing the full commands module.
 */
export function resolveCommandSession(
  target: string,
  sessionFlag: string | undefined,
  positionalSession: string | undefined,
): string | null {
  if (sessionFlag) return sessionFlag;
  if (positionalSession) return positionalSession;
  const fromPane = process.env.AMUX_DAEMON_SESSION;
  if (fromPane) return fromPane;
  return target === "session" ? null : "default";
}

/**
 * Pull a CLI-level `--session` out of a command group, attached or separated.
 * It never reaches `parseArgs`, whose schemas only know their own fields.
 */
function stripSessionFlag(
  argv: readonly string[],
): { rest: string[]; session?: string } | { error: string } {
  const rest: string[] = [];
  let session: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg !== "--session" && !arg.startsWith("--session=")) {
      rest.push(arg);
      continue;
    }
    let value: string;
    if (arg === "--session") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        return { error: "flag requires a value: --session" };
      value = next;
      i++;
    } else {
      value = arg.slice("--session=".length);
    }
    if (value === "") return { error: 'invalid value for --session: ""' };
    if (session !== undefined) return { error: "duplicate flag: --session" };
    session = value;
  }
  return { rest, session };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    const { generateHelp } = await import("./command-cli.ts");
    process.stdout.write(generateHelp() + "\n");
    return 0;
  }

  if (sub === "--skill") {
    const { generateSkill } = await import("./skill.ts");
    process.stdout.write(generateSkill());
    return 0;
  }

  const { generateGroupHelp } = await import("./command-cli.ts");
  const groupHelp = argv.length === 1 ? generateGroupHelp(sub) : undefined;
  if (groupHelp) {
    process.stdout.write(groupHelp + "\n");
    return 0;
  }

  if (sub === "daemon") {
    const { runDaemonMain } = await import("./daemon-main.ts");
    runDaemonMain(argv[1]);
    return 0;
  }

  if (sub === "status" || sub === "stop" || sub === "list") {
    const { runSessionCli } = await import("./session-cli.ts");
    return await runSessionCli(sub === "list" ? ["list"] : [sub, argv[1] ?? "default"]);
  }

  if (sub === "process-state") {
    return await (async () => {
      const state =
        argv.find((v) => v.startsWith("--state="))?.slice(8) ??
        (argv.includes("--state") ? argv[argv.indexOf("--state") + 1] : undefined);
      const socketPath = process.env.AMUX_PROCESS_STATE_SOCKET;
      // The session id, not the pane id: the report keys a session, and the
      // pane id can change when the pane moves.
      const agent = process.env.AMUX_AGENT_ID;
      if (!socketPath || !agent) {
        console.error("error: 'process-state' requires a managed pane");
        return 2;
      }
      const { isProcessState, reportProcessState, ProcessStateSchema } =
        await import("./process-state.ts");
      if (state === undefined || !isProcessState(state)) {
        console.error(`error: --state must be one of ${ProcessStateSchema.literals.join(", ")}`);
        return 2;
      }
      return await reportProcessState(socketPath, agent, state).then(
        () => 0,
        (error) => {
          console.error(`error: ${String(error)}`);
          return 1;
        },
      );
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
      return await Promise.resolve(
        action === "install" ? installOpencodeHook() : uninstallOpencodeHook(),
      ).then(
        (result) => {
          if (action === "install") console.log(`installed opencode hook at ${result}`);
          else console.log(result ? "removed opencode hook" : "no opencode hook installed");
          return 0;
        },
        (error) => {
          console.error(`error: ${String(error)}`);
          return 1;
        },
      );
    })();
  }

  // Command dispatch — needs Effect, control-client, commands, etc.
  const [
    effectMod,
    { SessionStore, isSessionId },
    { controlCall, agentWatch, AgentWaitError },
    commandsMod,
    { parseArgs, fieldNames, parsePluginArgs },
    { SESSION_STATE_TOPIC },
  ] = await Promise.all([
    import("effect"),
    import("./session.ts"),
    import("./control-client.ts"),
    import("./commands.ts"),
    import("./command-cli.ts"),
    import("./effect/AttachProtocol.ts"),
  ]);
  const { Effect, Option, Schema, Stream } = effectMod;
  const { COMMAND_META, Command, commandDefinition } = commandsMod;
  type CommandTag = (typeof Command.Type)["_tag"];
  type CommandContext = {
    size: { cols: number; rows: number };
    shell: readonly string[];
    cwd: string;
    agent?: string;
    pane?: string;
    noFocus?: boolean;
  };

  function isCommandTag(s: string): s is CommandTag {
    return s in COMMAND_META;
  }

  // A plugin verb the compiler has never seen — see commands.ts's
  // RuntimeCommandSchema. The CLI process has no plugin registry (plugins
  // load in an attached client), so this is a syntactic check only; the
  // daemon is what decides whether anyone can actually run it.
  function isPluginTag(s: string): boolean {
    return s.startsWith("plugin.");
  }

  /**
   * A command whose schema carries a `session` field acts on the session the
   * invocation drives, unless the args already named one. The field is the
   * workspace-side target; `--session` picks the daemon, and the two default to
   * the same session because driving one is almost always acting on it.
   */
  function fillCommandSession(
    tag: CommandTag,
    session: string | undefined,
    parsed: Record<string, import("./effect/AttachProtocol.ts").JsonValue>,
  ) {
    if (session === undefined || "session" in parsed) return parsed;
    if (!fieldNames(tag).some((field) => field.name === "session")) return parsed;
    return { ...parsed, session };
  }

  function parseCommandGroup(argv: string[]):
    | {
        tag: CommandTag;
        parsed: Record<string, import("./effect/AttachProtocol.ts").JsonValue>;
        positionalSession?: string;
        sessionFlag?: string;
      }
    | { errors: string[] } {
    const tag = argv[0];
    if (!tag || !isCommandTag(tag))
      return { errors: [`unknown command: ${JSON.stringify(tag ?? "")}`] };

    const stripped = stripSessionFlag(argv.slice(1));
    if ("error" in stripped) return { errors: [stripped.error] };

    const direct = parseArgs(tag, stripped.rest);
    if (direct.parsed)
      return {
        tag,
        parsed: fillCommandSession(tag, stripped.session, direct.parsed),
        sessionFlag: stripped.session,
      };

    // A command whose schema *requires* a session can only satisfy it from the
    // driving flag: the direct parse proved the args alone cannot. Re-parse
    // with the flag as a field so parseArgs applies its own rules unchanged.
    if (
      stripped.session !== undefined &&
      fieldNames(tag).some((field) => field.name === "session")
    ) {
      const refilled = parseArgs(tag, [...stripped.rest, `--session=${stripped.session}`]);
      if (refilled.parsed) return { tag, parsed: refilled.parsed, sessionFlag: stripped.session };
    }

    // The legacy `amux <command> <session-id> <args>` form. A token that looks
    // like a flag is never a session id, or a typo'd flag would turn a syntax
    // error into a refusal (exit 1) of a session the flag named.
    const positionalSession = argv[1];
    if (
      positionalSession &&
      !positionalSession.startsWith("--") &&
      isSessionId(positionalSession)
    ) {
      const legacy = parseArgs(tag, stripped.rest.slice(1));
      if (legacy.parsed)
        return {
          tag,
          parsed: fillCommandSession(tag, stripped.session, legacy.parsed),
          positionalSession,
          sessionFlag: stripped.session,
        };
    }
    return { errors: direct.errors };
  }

  // A plugin verb: no compile-time schema to chain, session-fill, or route by
  // target the way the core dispatch below does, so it gets its own minimal
  // path — one command per invocation, `--key=value` args, `--session`
  // required unless a pane's own env or a lone running session settles it.
  if (isPluginTag(sub)) {
    const stripped = stripSessionFlag(argv.slice(1));
    if ("error" in stripped) {
      console.error(`error: ${stripped.error}`);
      return 2;
    }
    const parsedArgs = parsePluginArgs(stripped.rest);
    if (!parsedArgs.parsed) {
      console.error(`error: ${parsedArgs.errors.join("\n  ")}`);
      return 2;
    }
    const targetId = resolveCommandSession("workspace", stripped.session, undefined);
    if (!targetId) {
      console.error(`error: '${sub}' requires a session id`);
      return 2;
    }
    const { BunFileSystem } = await import("@effect/platform-bun");
    return await Effect.runPromise(
      controlCall(targetId, (control) =>
        control.Batch({ values: [{ _tag: sub, ...parsedArgs.parsed }] }),
      ).pipe(Effect.provide(SessionStore.Default), Effect.provide(BunFileSystem.layer)),
    ).then(
      ({ outputs }) => {
        const result = outputs[0]?.result;
        if (result !== undefined) {
          const text = Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(result), () =>
            JSON.stringify(result, null, 2),
          );
          process.stdout.write(text + "\n");
        }
        return 0;
      },
      (error) => {
        console.error(`error: ${String(error)}`);
        return 1;
      },
    );
  }

  if (isCommandTag(sub)) {
    const groups = splitCommandArgs(argv);
    const cmds: (typeof Command.Type)[] = [];
    let id: string | undefined;
    // --no-focus is a batch-level context flag, not a command field: it says
    // "this whole invocation is background work, do not move the human's focus".
    let noFocus = false;
    for (const group of groups) {
      const cleaned = group.filter((arg) => {
        if (arg === "--no-focus") {
          noFocus = true;
          return false;
        }
        return true;
      });
      const parsed = parseCommandGroup(cleaned);
      if ("errors" in parsed) {
        console.error(`error: ${parsed.errors.join("\n  ")}`);
        return 2;
      }
      const targetId: string | null = resolveCommandSession(
        commandDefinition(parsed.tag).target,
        parsed.sessionFlag,
        parsed.positionalSession,
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
    if (cmds.some((command) => command._tag === "agent.new")) {
      const { ensureDaemon } = await import("./client.ts");
      const started = await Effect.runPromise(
        ensureDaemon(id!).pipe(
          Effect.provide(SessionStore.Default),
          Effect.provide(BunFileSystem.layer),
        ),
      ).then(
        () => true,
        (error) => {
          console.error(`error: ${String(error)}`);
          return false;
        },
      );
      if (!started) return 1;
    }
    const prompt = cmds.length === 1 && cmds[0]?._tag === "agent.prompt" ? cmds[0] : undefined;
    const watch = cmds.length === 1 && cmds[0]?._tag === "agent.watch" ? cmds[0] : undefined;
    if (watch) {
      return await Effect.runPromise(
        controlCall(id!, (control) =>
          agentWatch(control, watch.target, watch.after).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => process.stdout.write(JSON.stringify(event) + "\n")),
            ),
          ),
        ).pipe(Effect.provide(SessionStore.Default), Effect.provide(BunFileSystem.layer)),
      ).then(
        () => 0,
        (error) => {
          console.error(`error: ${String(error)}`);
          return 1;
        },
      );
    }
    const runResult = Effect.runPromise(
      controlCall(id!, (control) => {
        const context: CommandContext = {
          size: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
          shell: [process.env.SHELL ?? "sh"],
          cwd: process.cwd(),
          // The calling pane and its session, when this CLI runs inside one.
          // The daemon resolves --current from these; it never trusts the CLI
          // to have picked a pane.
        };
        if (process.env.AMUX_AGENT_ID) context.agent = process.env.AMUX_AGENT_ID;
        if (process.env.AMUX_PANE_ID) context.pane = process.env.AMUX_PANE_ID;
        if (noFocus) context.noFocus = true;
        if (!prompt || (prompt.wait !== true && prompt.until === undefined))
          return control.Batch({ values: [...cmds], context });

        return Effect.gen(function* () {
          const after = yield* control.AgentCursor({ session: prompt.target });
          const { outputs } = yield* control.Batch({ values: [...cmds], context });
          const timeout = prompt.timeout ?? 30000;
          const deadline = Date.now() + timeout;
          const first = yield* agentWatch(control, prompt.target, after).pipe(
            Stream.filter(
              (event) =>
                event._tag === "turn.start" ||
                (event._tag === "topic" && event.topic === SESSION_STATE_TOPIC),
            ),
            Stream.runHead,
            Effect.timeoutFail({
              duration: Math.min(5000, timeout),
              onTimeout: () => new AgentWaitError({ reason: "agent_prompt_stalled" }),
            }),
          );
          if (Option.isNone(first))
            return { outputs: [...outputs, { result: { error: "agent_prompt_stalled" } }] };
          let turn: string | undefined;
          let result: typeof first.value | undefined;
          const fold = (event: typeof first.value) => {
            if (event._tag === "turn.start" && turn === undefined) turn = event.turn;
            if (event._tag === "turn.end" && event.turn === turn) {
              result = event;
              return true;
            }
            if (
              prompt.until !== undefined &&
              event._tag === "topic" &&
              event.topic === SESSION_STATE_TOPIC &&
              event.payload === prompt.until
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
                onTimeout: () => new AgentWaitError({ reason: "agent_wait_timeout" }),
              }),
            );
          return { outputs: [...outputs, { result: result ?? { turn } }] };
        });
      }).pipe(Effect.provide(SessionStore.Default), Effect.provide(BunFileSystem.layer)),
    );

    return await runResult.then(
      ({ outputs }) => {
        for (const { result } of outputs) {
          if (result !== undefined) {
            const text = Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(result), () =>
              JSON.stringify(result, null, 2),
            );
            process.stdout.write(text + "\n");
          }
        }
        return 0;
      },
      (error) => {
        console.error(`error: ${String(error)}`);
        return 1;
      },
    );
  }

  // `amux new <id>` is the only spelling allowed to create a session: it
  // attaches exactly like the plain form below, but skips the existence
  // check since creating is the point.
  if (sub === "new") {
    const id = argv[1];
    if (!id || !isSessionId(id)) {
      console.error("usage: amux new <session-id>");
      return 2;
    }
    process.env.AMUX_SESSION = id;
    await import("./main.tsx");
    return 0;
  }

  // Session attach — refuses to create. A mistyped command is also a valid
  // session id, so silently spinning up a daemon for it here would turn a
  // typo into an orphaned session instead of an error.
  if (!isSessionId(sub)) {
    console.error(`unknown command or invalid session id: ${JSON.stringify(sub)}`);
    return 2;
  }
  const { BunFileSystem } = await import("@effect/platform-bun");
  const known = await Effect.runPromise(
    SessionStore.exists(sub).pipe(
      Effect.provide(SessionStore.Default),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  if (!known) {
    console.error(`no session named ${JSON.stringify(sub)} — run \`amux new ${sub}\` to create it`);
    return 2;
  }
  process.env.AMUX_SESSION = sub;
  await import("./main.tsx");
  return 0;
}

if (import.meta.main) {
  main().then((code) => (process.exitCode = code));
}
