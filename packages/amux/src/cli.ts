#!/usr/bin/env bun
/**
 * The single `amux` binary.
 *
 * Dispatches on the first argument:
 * - `amux` (no args) — attach to the one running session, list them if
 *   several, or create and attach `default` if none is running
 * - `amux [session-id]` — attach to an existing session
 * - `amux new <session-id>` — create (or resume) a session and attach
 * - `amux daemon [id]` — run the daemon foreground
 * - `amux status|stop|list [id]` — one-shot lifecycle commands
 * - `amux plugin add|rm|ls|upgrade` — manage the plugin store and config
 * - `amux <command> [args]` — invoke a remote command via the daemon RPC
 * - `amux help` — show usage
 *
 * `amux <session-id>` never creates: a name that has no session directory
 * yet is refused rather than silently spun up, because a session id doubles
 * as a fallback for any unrecognized first argument — a mistyped command
 * would otherwise create and attach a throwaway session instead of erroring.
 * `amux new` and the bare no-args form are the only spellings allowed to
 * create. Anything else that isn't a real dispatch target — unknown command
 * or nonexistent session — prints help and exits 0 rather than erroring.
 *
 * Static imports are deliberately absent: Bun evaluates them before main() runs,
 * so this file has none. Every subcommand lazy-loads only what it needs, keeping
 * `process-state` sub-millisecond.
 */
import { Clock, Config, ConfigProvider, Effect, Layer, Option, Schema, Stream } from "effect";

const writeOut = (text: string) => process.stdout.write(text + "\n");
const writeErr = (text: string) => process.stderr.write(text + "\n");
const readEnv = (name: string): string | undefined =>
  Option.getOrUndefined(
    Effect.runSync(
      Config.option(Config.string(name)).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
      ),
    ),
  );
const runClient = (session: string): Effect.Effect<number> =>
  Effect.promise(() => {
    const child = Bun.spawn(
      [
        "env",
        `AMUX_SESSION=${session}`,
        process.execPath,
        new URL("./main.tsx", import.meta.url).pathname,
      ],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    return child.exited;
  });

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
  const fromPane = readEnv("AMUX_DAEMON_SESSION");
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

/**
 * A plugin's own CLI subcommand — a setup verb like an agent-hook installer,
 * not a second command system. Building the CLI's plugin host costs real
 * time (it loads every configured plugin), so this runs only on the fallback
 * path below, once nothing built into this file has already matched `sub`.
 */
const dispatchPluginCommand = Effect.fnUntraced(function* (sub: string, argv: string[]) {
  const { dispatchCliCommand } = yield* Effect.promise(() => import("./plugin/cli-host.ts"));
  const result = yield* Effect.promise(() => dispatchCliCommand(sub, argv));
  if ("code" in result) return result.code;
  const { generateHelp } = yield* Effect.promise(() => import("./command-cli.ts"));
  let text = generateHelp();
  if (result.refused.length > 0) {
    text +=
      "\n\nPlugins unavailable outside an attached client:\n" +
      result.refused.map((r) => `  ${r.id} (needs ${r.key})`).join("\n");
  }
  writeOut(text);
  return 0;
});

function main(): Effect.Effect<number> {
  return Effect.gen(function* () {
    const argv = process.argv.slice(2);
    const sub = argv[0];

    if (sub === "help" || sub === "--help" || sub === "-h") {
      const { generateHelp } = yield* Effect.promise(() => import("./command-cli.ts"));
      process.stdout.write(generateHelp() + "\n");
      return 0;
    }

    // Bare `amux` — tmux-style default: attach to whatever's running. No
    // session running yet creates (and attaches) `default`; exactly one
    // running session attaches to it directly; more than one is ambiguous, so
    // list them and let the caller name one explicitly rather than guessing.
    if (!sub) {
      const { runningSessionIds } = yield* Effect.promise(() => import("./session-cli.ts"));
      const running = yield* Effect.promise(() => runningSessionIds());
      if (running.length > 1) {
        writeErr("Multiple sessions are running:");
        for (const id of running) writeErr(`  ${id}`);
        writeErr("Run `amux <session-id>` to attach to one.");
        return 1;
      }
      return yield* runClient(running[0] ?? "default");
    }

    if (sub === "--skill") {
      const { generateSkill } = yield* Effect.promise(() => import("./skill.ts"));
      process.stdout.write(generateSkill());
      return 0;
    }

    const { generateGroupHelp } = yield* Effect.promise(() => import("./command-cli.ts"));
    const groupHelp = argv.length === 1 ? generateGroupHelp(sub) : undefined;
    if (groupHelp) {
      process.stdout.write(groupHelp + "\n");
      return 0;
    }

    if (sub === "daemon") {
      const { runDaemonMain } = yield* Effect.promise(() => import("./daemon-main.ts"));
      runDaemonMain(argv[1] ?? "default");
      return 0;
    }

    if (sub === "status" || sub === "stop" || sub === "list") {
      const { runSessionCli } = yield* Effect.promise(() => import("./session-cli.ts"));
      if (sub === "list") return yield* Effect.promise(() => runSessionCli(["list"]));
      const stripped = stripSessionFlag(argv.slice(1));
      if ("error" in stripped) {
        writeErr(`error: ${stripped.error}`);
        return 2;
      }
      const id = stripped.session ?? stripped.rest[0] ?? "default";
      return yield* Effect.promise(() => runSessionCli([sub, id]));
    }

    if (sub === "process-state") {
      return yield* Effect.gen(function* () {
        const state =
          argv.find((v) => v.startsWith("--state="))?.slice(8) ??
          (argv.includes("--state") ? argv[argv.indexOf("--state") + 1] : undefined);
        const socketPath = readEnv("AMUX_PROCESS_STATE_SOCKET");
        // The session id, not the pane id: the report keys a session, and the
        // pane id can change when the pane moves.
        const agent = readEnv("AMUX_AGENT_ID");
        if (!socketPath || !agent) {
          writeErr("error: 'process-state' requires a managed pane");
          return 2;
        }
        const { isProcessState, reportProcessState, ProcessStateSchema } = yield* Effect.promise(
          () => import("./process-state.ts"),
        );
        if (state === undefined || !isProcessState(state)) {
          writeErr(`error: --state must be one of ${ProcessStateSchema.literals.join(", ")}`);
          return 2;
        }
        return yield* Effect.promise(() =>
          reportProcessState(socketPath, agent, state).then(
            () => 0,
            (error) => {
              writeErr(`error: ${String(error)}`);
              return 1;
            },
          ),
        );
      });
    }

    // Plugin store management — carved into core's CLI rather than
    // plugin-registered: these verbs edit the store and the config file, so
    // they work with zero plugins installed, when no registry exists to
    // register them into.
    if (sub === "plugin") {
      const { runPluginCli } = yield* Effect.promise(() => import("./plugin/plugin-cli.ts"));
      return yield* Effect.promise(() => runPluginCli(argv.slice(1)));
    }

    // Command dispatch — needs Effect, control-client, commands, etc.
    const [
      { SessionStore, isSessionId },
      { controlCall, agentWatch, AgentWaitError },
      commandsMod,
      { parseArgs, fieldNames, parsePluginArgs },
      { SESSION_STATE_TOPIC },
    ] = yield* Effect.promise(() =>
      Promise.all([
        import("./session.ts"),
        import("./control-client.ts"),
        import("./commands.ts"),
        import("./command-cli.ts"),
        import("./effect/AttachProtocol.ts"),
      ]),
    );
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
        writeErr(`error: ${stripped.error}`);
        return 2;
      }
      const parsedArgs = parsePluginArgs(stripped.rest);
      if (!parsedArgs.parsed) {
        writeErr(`error: ${parsedArgs.errors.join("\n  ")}`);
        return 2;
      }
      const targetId = resolveCommandSession("workspace", stripped.session, undefined);
      if (!targetId) {
        writeErr(`error: '${sub}' requires a session id`);
        return 2;
      }
      const { BunFileSystem } = yield* Effect.promise(() => import("@effect/platform-bun"));
      return yield* controlCall(targetId, (control) =>
        control.Batch({ values: [{ _tag: sub, ...parsedArgs.parsed }] }),
      ).pipe(
        Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
        Effect.map(({ outputs }) => {
          const result = outputs[0]?.result;
          if (result !== undefined) {
            const text = Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(result), () =>
              Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(result),
            );
            process.stdout.write(text + "\n");
          }
          return 0;
        }),
        Effect.catch((error) =>
          Effect.sync(() => {
            writeErr(`error: ${String(error)}`);
            return 1;
          }),
        ),
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
          writeErr(`error: ${parsed.errors.join("\n  ")}`);
          return 2;
        }
        const targetId: string | null = resolveCommandSession(
          commandDefinition(parsed.tag).target,
          parsed.sessionFlag,
          parsed.positionalSession,
        );
        if (!targetId) {
          writeErr(`error: '${parsed.tag}' requires a session id or a managed pane`);
          return 2;
        }
        if (id !== undefined && targetId !== id) {
          writeErr("error: chained commands must target the same daemon session");
          return 2;
        }
        id = targetId;
        cmds.push(
          yield* Schema.decodeUnknownEffect(Command)({ _tag: parsed.tag, ...parsed.parsed }),
        );
      }

      const { BunFileSystem } = yield* Effect.promise(() => import("@effect/platform-bun"));
      if (cmds.some((command) => command._tag === "agent.new")) {
        const { ensureDaemon } = yield* Effect.promise(() => import("./client.ts"));
        const started = yield* ensureDaemon(id!).pipe(
          Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.sync(() => {
              writeErr(`error: ${String(error)}`);
              return false;
            }),
          ),
        );
        if (!started) return 1;
      }
      const prompt = cmds.length === 1 && cmds[0]?._tag === "agent.prompt" ? cmds[0] : undefined;
      const watch = cmds.length === 1 && cmds[0]?._tag === "agent.watch" ? cmds[0] : undefined;
      if (watch) {
        return yield* controlCall(id!, (control) =>
          agentWatch(control, watch.target, watch.after).pipe(
            Stream.runForEach((event) =>
              Effect.flatMap(
                Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(event),
                (text) => Effect.sync(() => writeOut(text)),
              ),
            ),
          ),
        ).pipe(
          Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
          Effect.as(0),
          Effect.catch((error) =>
            Effect.sync(() => {
              writeErr(`error: ${String(error)}`);
              return 1;
            }),
          ),
        );
      }
      const runResult = controlCall(id!, (control) => {
        const context: CommandContext = {
          size: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
          shell: [readEnv("SHELL") ?? "sh"],
          cwd: process.cwd(),
          // The calling pane and its session, when this CLI runs inside one.
          // The daemon resolves --current from these; it never trusts the CLI
          // to have picked a pane.
        };
        if (readEnv("AMUX_AGENT_ID")) context.agent = readEnv("AMUX_AGENT_ID");
        if (readEnv("AMUX_PANE_ID")) context.pane = readEnv("AMUX_PANE_ID");
        if (noFocus) context.noFocus = true;
        if (!prompt || (prompt.wait !== true && prompt.until === undefined))
          return control.Batch({ values: [...cmds], context });

        return Effect.gen(function* () {
          const after = yield* control.AgentCursor({ session: prompt.target });
          const { outputs } = yield* control.Batch({ values: [...cmds], context });
          const timeout = prompt.timeout ?? 30000;
          const deadline = (yield* Clock.currentTimeMillis) + timeout;
          // The CLI follows a prompt through the one signal core owns: the
          // session's published state. A turn is the harness's idea, and this
          // process loads no plugins, so it has no way to recognise one and no
          // business asserting that a session has them.
          const settled = prompt.until ?? "idle";
          const publishedState = (event: {
            readonly _tag: string;
            readonly topic?: string;
            readonly payload?: unknown;
          }) => (event.topic === SESSION_STATE_TOPIC ? event.payload : undefined);

          // Waiting for `settled` alone would return at once when the session
          // is still in it: this waits for the prompt to move it first.
          const first = yield* agentWatch(control, prompt.target, after).pipe(
            Stream.filter((event) => {
              const state = publishedState(event);
              return state !== undefined && state !== settled;
            }),
            Stream.runHead,
            Effect.timeoutOrElse({
              duration: Math.min(5000, timeout),
              orElse: () => Effect.fail(new AgentWaitError({ reason: "agent_prompt_stalled" })),
            }),
          );
          if (Option.isNone(first))
            return { outputs: [...outputs, { result: { error: "agent_prompt_stalled" } }] };
          let result: typeof first.value | undefined;
          const fold = (event: typeof first.value) => {
            if (publishedState(event) !== settled) return false;
            result = event;
            return true;
          };
          if (!fold(first.value))
            yield* agentWatch(control, prompt.target, first.value.sequence).pipe(
              Stream.takeUntil((event) => {
                return fold(event);
              }),
              Stream.runDrain,
              Effect.timeoutOrElse({
                duration: Math.max(0, deadline - (yield* Clock.currentTimeMillis)),
                orElse: () => Effect.fail(new AgentWaitError({ reason: "agent_wait_timeout" })),
              }),
            );
          return { outputs: [...outputs, { result: result ?? { state: settled } }] };
        });
      }).pipe(Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))));

      return yield* runResult.pipe(
        Effect.map(({ outputs }) => {
          for (const { result } of outputs) {
            if (result !== undefined) {
              const text = Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(result), () =>
                Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(result),
              );
              process.stdout.write(text + "\n");
            }
          }
          return 0;
        }),
        Effect.catch((error) =>
          Effect.sync(() => {
            writeErr(`error: ${String(error)}`);
            return 1;
          }),
        ),
      );
    }

    // `amux new <id>` is the only spelling allowed to create a session: it
    // attaches exactly like the plain form below, but skips the existence
    // check since creating is the point.
    if (sub === "new") {
      const id = argv[1];
      if (!id || !isSessionId(id)) {
        writeErr("usage: amux new <session-id>");
        return 2;
      }
      return yield* runClient(id);
    }

    // Session attach — refuses to create. A mistyped command is also a valid
    // session id, so silently spinning up a daemon for it here would turn a
    // typo into an orphaned session instead of an error. Anything that isn't
    // a real dispatch target — unknown command or nonexistent session —
    // falls back to help rather than erroring, so a typo is a noop.
    if (!isSessionId(sub)) {
      return yield* dispatchPluginCommand(sub, argv.slice(1));
    }
    const { BunFileSystem } = yield* Effect.promise(() => import("@effect/platform-bun"));
    const known = yield* Effect.flatMap(SessionStore, (store) => store.exists(sub)).pipe(
      Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
    );
    if (!known) {
      return yield* dispatchPluginCommand(sub, argv.slice(1));
    }
    return yield* runClient(sub);
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        writeErr(`error: ${String(error)}`);
        return 1;
      }),
    ),
  );
}

if (import.meta.main) {
  Effect.runPromise(main()).then((code) => (process.exitCode = code));
}
