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
 * - `amux plugin add|rm|ls|upgrade` — manage Cordis (in-process) plugins
 * - `amux process-plugin …` — link/run out-of-process argv plugins
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
import {
  Clock,
  Config,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Runtime,
  Schema,
  Stream,
} from "effect";
import { BunRuntime } from "@effect/platform-bun";
import type { RegisteredCommand } from "./commands.ts";
import type { PluginCommandDeclaration } from "./plugin-behaviour.ts";
import type { CliArgValue } from "./command-cli.ts";
import { OwnerJsonText } from "./layout.ts";

const writeOut = (text: string) => process.stdout.write(text + "\n");
const writeErr = (text: string) => process.stderr.write(text + "\n");

/** Print one Batch result: a JSON string value raw, anything else as 2-space JSON. */
const printBatchResult = (result: OwnerJsonText): Effect.Effect<void, string> =>
  Effect.gen(function* () {
    const nested = yield* Schema.encodeEffect(OwnerJsonText)(result).pipe(
      Effect.mapError((error) => String(error)),
    );
    const text =
      typeof nested === "string"
        ? nested
        : yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
            nested,
          ).pipe(Effect.mapError((error) => String(error)));
    process.stdout.write(text + "\n");
  });
const readEnv = (name: string): string | undefined =>
  Option.getOrUndefined(
    Effect.runSync(
      Config.option(Config.string(name)).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
      ),
    ),
  );

/**
 * tmux refuses to nest a second server inside a pane it already owns unless
 * $TMUX is unset first; a pane amux spawns carries the same kind of marker
 * (AMUX_DAEMON_SESSION, set so a command run from inside a pane can resolve
 * its own daemon without --session). Rendering a second client into that
 * pane corrupts the outer client's terminal state — mode-setting, alt-screen,
 * and mouse-tracking sequences from the inner renderer land in a terminal the
 * outer renderer still thinks it owns exclusively.
 */
const runClient = (session: string): Effect.Effect<number> => {
  const nestedIn = readEnv("AMUX_DAEMON_SESSION");
  if (nestedIn !== undefined) {
    return Effect.sync(() => {
      writeErr(
        `error: already inside amux (session '${nestedIn}'); sessions should be nested with care, unset AMUX_DAEMON_SESSION to force`,
      );
      return 1;
    });
  }
  return Effect.promise(() => {
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
};

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
 * argument. Accepts the target string directly (not a CommandTag) so this
 * file avoids importing the full commands module.
 * A `workspace` target always resolves (flag, then AMUX_DAEMON_SESSION, then
 * `default`); only `session` can return null outside a managed pane.
 */
export function resolveCommandSession(target: "workspace", sessionFlag: string | undefined): string;
export function resolveCommandSession(
  target: string,
  sessionFlag: string | undefined,
): string | null;
export function resolveCommandSession(
  target: string,
  sessionFlag: string | undefined,
): string | null {
  if (sessionFlag) return sessionFlag;
  const fromPane = readEnv("AMUX_DAEMON_SESSION");
  if (fromPane) return fromPane;
  return target === "session" ? null : "default";
}

/**
 * Pull a CLI-level `--session` out of a command group, attached or separated.
 * It never reaches `parseArgs`, whose schemas only know their own fields.
 */
export function stripSessionFlag(
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
 * A command whose schema carries a `session` field acts on the session the
 * invocation drives, unless the args already named one. `--session` picks the
 * daemon; the field is the workspace-side target, and the two default to the
 * same id because driving one is almost always acting on it.
 */
export function fillCommandSession(
  session: string | undefined,
  parsed: Record<string, CliArgValue>,
  hasSessionField: boolean,
) {
  if (session === undefined || "session" in parsed || !hasSessionField) return parsed;
  return { ...parsed, session } satisfies Record<string, CliArgValue>;
}

/**
 * Core help plus any plugin declarations a live session daemon reports.
 * Never starts a daemon; appends the daemon note when none answers.
 */
const pluginAwareHelpText = Effect.fnUntraced(function* (sessionFlag: string | undefined) {
  const [
    { generateHelp, PLUGIN_COMMANDS_DAEMON_NOTE },
    { fetchPluginDeclarations },
    { BunFileSystem },
    { SessionStore },
  ] = yield* Effect.promise(() =>
    Promise.all([
      import("./command-cli.ts"),
      import("./fetch-plugin-declarations.ts"),
      import("@effect/platform-bun"),
      import("./session.ts"),
    ]),
  );
  const fetched = yield* fetchPluginDeclarations(
    resolveCommandSession("workspace", sessionFlag),
  ).pipe(Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))));
  let text = generateHelp(fetched.commands);
  if (!fetched.daemonAnswered) text += "\n\n" + PLUGIN_COMMANDS_DAEMON_NOTE;
  return text;
});

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
  let text = yield* pluginAwareHelpText(undefined);
  if (result.refused.length > 0) {
    text +=
      "\n\nPlugins unavailable outside an attached client:\n" +
      result.refused.map((r) => `  ${r.id} (needs ${r.key})`).join("\n");
  }
  if (result.failures.length > 0) {
    text +=
      "\n\nPlugin load failures:\n" +
      result.failures.map((f) => `  ${f.spec}: ${f.reason}`).join("\n");
  }
  writeOut(text);
  return 0;
});

function main(): Effect.Effect<number> {
  return Effect.gen(function* () {
    const argv = process.argv.slice(2);
    const sub = argv[0];

    if (sub === "help" || sub === "--help" || sub === "-h") {
      const stripped = stripSessionFlag(argv.slice(1));
      if ("error" in stripped) {
        writeErr(`error: ${stripped.error}`);
        return 2;
      }
      process.stdout.write((yield* pluginAwareHelpText(stripped.session)) + "\n");
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

    if (sub === "plugin-host") {
      const { runPluginHostMain } = yield* Effect.promise(() => import("./plugin-host/main.ts"));
      runPluginHostMain();
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
        const { reportProcessState, ProcessStateSchema } = yield* Effect.promise(
          () => import("./process-state.ts"),
        );
        const decoded = Option.flatMap(
          Option.fromNullishOr(state),
          Schema.decodeUnknownOption(ProcessStateSchema),
        );
        if (Option.isNone(decoded)) {
          writeErr(`error: --state must be one of ${ProcessStateSchema.literals.join(", ")}`);
          return 2;
        }
        return yield* reportProcessState(socketPath, agent, decoded.value).pipe(
          Effect.as(0),
          Effect.catch((error) => {
            writeErr(`error: ${String(error)}`);
            return Effect.succeed(1);
          }),
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

    if (sub === "process-plugin") {
      const { runProcessPluginCli } = yield* Effect.promise(
        () => import("./process-plugin/cli.ts"),
      );
      return yield* Effect.promise(() => runProcessPluginCli(argv.slice(1)));
    }

    // Command dispatch — needs Effect, control-client, commands, etc.
    const [
      { SessionStore, isSessionId },
      { controlCall, agentWatch, AgentWaitError },
      commandsMod,
      { parseArgs, fieldNames, parseFields, parsePluginArgs, encodeCliParsedArgs },
      { SESSION_STATE_TOPIC, AgentEvent },
      { ProcessStateSchema },
    ] = yield* Effect.promise(() =>
      Promise.all([
        import("./session.ts"),
        import("./control-client.ts"),
        import("./commands.ts"),
        import("./command-cli.ts"),
        import("./effect/AttachProtocol.ts"),
        import("./process-state.ts"),
      ]),
    );
    const {
      COMMAND_META,
      Command,
      commandDefinition,
      isCoreCommandTag,
      isClientPluginCommandTag,
      isRegisteredCommand,
      registeredCommand,
    } = commandsMod;
    // `new`, an out-of-schema plugin verb (its own single-command path
    // below, matched by the client-plugin namespace alone), and a bare
    // session-id attach never consult daemonCommandByTag — they dispatch on
    // sub alone, without ever reaching parseCommandGroup/isCommandTag. Asking
    // a daemon for declarations none of them will read would just tax those
    // paths (notably runClient's nesting-guard refusal) for nothing. Every
    // core and daemon command tag is dot-namespaced ("pane.split",
    // "agent.new"), so a bare, dot-free sub unambiguously can't be one — the
    // only shape a real session id takes here, since a dotted sub must still
    // be checked against daemonCommands in case it names a plugin verb.
    const commandGroups = splitCommandArgs(argv);
    const needsDeclarations =
      sub !== "new" &&
      !isClientPluginCommandTag(sub) &&
      !(!sub.includes(".") && isSessionId(sub)) &&
      commandGroups.some((group) => group[0] !== undefined && !isCoreCommandTag(group[0]));
    let daemonCommands: readonly PluginCommandDeclaration[] = [];
    let daemonAnswered = false;
    if (needsDeclarations) {
      let sessionFlag: string | undefined;
      for (const group of commandGroups) {
        const cleaned = group.slice(1).filter((arg) => arg !== "--no-focus");
        const stripped = stripSessionFlag(cleaned);
        if ("error" in stripped) {
          writeErr(`error: ${stripped.error}`);
          return 2;
        }
        if (stripped.session !== undefined) {
          if (sessionFlag !== undefined && stripped.session !== sessionFlag) {
            writeErr("error: chained commands must target the same daemon session");
            return 2;
          }
          sessionFlag = stripped.session;
        }
      }
      const sessionId = resolveCommandSession("workspace", sessionFlag);
      const { BunFileSystem } = yield* Effect.promise(() => import("@effect/platform-bun"));
      // agent.new is a plugin daemon command (plugin-agent-harness), so
      // needsDeclarations is already true; start the daemon before fetching
      // its declaration so `agent.new ; <plugin verb>` can parse.
      if (commandGroups.some((group) => group[0] === "agent.new")) {
        const { ensureDaemon } = yield* Effect.promise(() => import("./client.ts"));
        const started = yield* ensureDaemon(sessionId).pipe(
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
      const { fetchPluginDeclarations } = yield* Effect.promise(
        () => import("./fetch-plugin-declarations.ts"),
      );
      const fetched = yield* fetchPluginDeclarations(sessionId).pipe(
        Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
      );
      daemonCommands = fetched.commands;
      daemonAnswered = fetched.daemonAnswered;
    }
    const daemonCommandByTag = new Map(daemonCommands.map((record) => [record.tag, record]));
    type CommandTag = string;
    type CommandContext = {
      size: { cols: number; rows: number };
      shell: readonly string[];
      cwd: string;
      source: "cli";
      agent?: string;
      pane?: string;
      originSession?: string;
      noFocus?: boolean;
    };
    const PromptFieldsSchema = Schema.Struct({
      target: Schema.String,
      wait: Schema.optionalKey(Schema.Boolean),
      until: Schema.optionalKey(Schema.String),
      timeout: Schema.optionalKey(Schema.Int),
    });
    const WatchFieldsSchema = Schema.Struct({
      target: Schema.String,
      after: Schema.optionalKey(Schema.Int),
    });
    const registeredArgs = <A>(
      value: typeof Command.Type | RegisteredCommand,
      schema: Schema.Codec<A>,
    ): Option.Option<A> => {
      if (!isRegisteredCommand(value)) return Option.none();
      return Schema.decodeOption(Schema.fromJsonString(schema))(value.args);
    };
    const isPromptCommand = (
      value: typeof Command.Type | RegisteredCommand,
    ): value is RegisteredCommand & { readonly _tag: "agent.prompt" } =>
      value._tag === "agent.prompt";
    const isWatchCommand = (
      value: typeof Command.Type | RegisteredCommand,
    ): value is RegisteredCommand & { readonly _tag: "agent.watch" } =>
      value._tag === "agent.watch";

    function isCommandTag(s: string): s is CommandTag {
      return s in COMMAND_META || daemonCommandByTag.has(s) || isClientPluginCommandTag(s);
    }

    function parseCommandGroup(argv: string[]): Effect.Effect<
      | {
          tag: CommandTag;
          parsed: Record<string, CliArgValue>;
          sessionFlag?: string;
        }
      | { errors: string[] }
    > {
      return Effect.sync(() => {
        const tag = argv[0];
        if (!tag || !isCommandTag(tag)) {
          const quoted = tag === undefined ? '""' : `"${tag}"`;
          const message = `unknown command: ${quoted}`;
          if (needsDeclarations && !daemonAnswered) {
            return {
              errors: [`${message} (plugin commands need the session daemon to be running)`],
            };
          }
          return { errors: [message] };
        }

        const stripped = stripSessionFlag(argv.slice(1));
        if ("error" in stripped) return { errors: [stripped.error] };

        const daemonCommand = daemonCommandByTag.get(tag);
        const direct = isCoreCommandTag(tag)
          ? parseArgs(tag, stripped.rest)
          : daemonCommand
            ? parseFields(tag, daemonCommand.fields, stripped.rest)
            : parsePluginArgs(stripped.rest);
        if (!direct.parsed) return { errors: direct.errors };
        const hasSessionField =
          isCoreCommandTag(tag) && fieldNames(tag).some((field) => field.name === "session");
        return {
          tag,
          parsed: fillCommandSession(stripped.session, direct.parsed, hasSessionField),
          sessionFlag: stripped.session,
        };
      });
    }

    // A plugin verb: no compile-time schema to chain, session-fill, or route by
    // target the way the core dispatch below does, so it gets its own minimal
    // path — one command per invocation, `--key=value` args, `--session`
    // required unless a pane's own env or a lone running session settles it.
    if (isClientPluginCommandTag(sub)) {
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
      const parsed = parsedArgs.parsed;
      const targetId = resolveCommandSession("workspace", stripped.session);
      if (!targetId) {
        writeErr(`error: '${sub}' requires a session id`);
        return 2;
      }
      const { BunFileSystem } = yield* Effect.promise(() => import("@effect/platform-bun"));
      return yield* controlCall(targetId, (control) => {
        const agent = readEnv("AMUX_AGENT_ID");
        const pane = readEnv("AMUX_PANE_ID");
        const originSession = readEnv("AMUX_SESSION");
        const base = {
          size: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
          shell: [readEnv("SHELL") ?? "sh"],
          cwd: process.cwd(),
          source: "cli" as const,
        };
        const context =
          agent && pane && originSession
            ? { ...base, agent, pane, originSession }
            : agent && pane
              ? { ...base, agent, pane }
              : agent && originSession
                ? { ...base, agent, originSession }
                : pane && originSession
                  ? { ...base, pane, originSession }
                  : agent
                    ? { ...base, agent }
                    : pane
                      ? { ...base, pane }
                      : originSession
                        ? { ...base, originSession }
                        : base;
        return Effect.gen(function* () {
          const argsText = yield* encodeCliParsedArgs(parsed).pipe(
            Effect.mapError((message) => new Error(message)),
          );
          return yield* control.Batch({
            values: [registeredCommand(sub, argsText)],
            context,
          });
        });
      }).pipe(
        Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
        Effect.flatMap(({ outputs }) =>
          Effect.gen(function* () {
            const result = outputs[0]?.result;
            if (result !== undefined) yield* printBatchResult(result);
            return 0;
          }),
        ),
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
      const cmds: Array<typeof Command.Type | RegisteredCommand> = [];
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
        const parsed = yield* parseCommandGroup(cleaned);
        if ("errors" in parsed) {
          writeErr(`error: ${parsed.errors.join("\n  ")}`);
          return 2;
        }
        const targetId: string | null = resolveCommandSession(
          isCoreCommandTag(parsed.tag)
            ? commandDefinition(parsed.tag).target
            : (daemonCommandByTag.get(parsed.tag)?.meta.target ?? "workspace"),
          parsed.sessionFlag,
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
          isCoreCommandTag(parsed.tag)
            ? yield* Schema.decodeUnknownEffect(Command)({ _tag: parsed.tag, ...parsed.parsed })
            : registeredCommand(
                parsed.tag,
                yield* encodeCliParsedArgs(parsed.parsed).pipe(
                  Effect.mapError((message) => new Error(message)),
                ),
              ),
        );
      }

      const { BunFileSystem } = yield* Effect.promise(() => import("@effect/platform-bun"));
      const promptValue =
        cmds.length === 1 && cmds[0] && isPromptCommand(cmds[0]) ? cmds[0] : undefined;
      const watchValue =
        cmds.length === 1 && cmds[0] && isWatchCommand(cmds[0]) ? cmds[0] : undefined;
      const prompt = promptValue
        ? Option.getOrUndefined(registeredArgs(promptValue, PromptFieldsSchema))
        : undefined;
      const watch = watchValue
        ? Option.getOrUndefined(registeredArgs(watchValue, WatchFieldsSchema))
        : undefined;
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
          source: "cli",
          // The calling pane and its session, when this CLI runs inside one.
          // The daemon resolves the target from these; it never trusts the CLI
          // to have picked a pane.
        };
        if (readEnv("AMUX_AGENT_ID")) context.agent = readEnv("AMUX_AGENT_ID");
        if (readEnv("AMUX_PANE_ID")) context.pane = readEnv("AMUX_PANE_ID");
        if (readEnv("AMUX_SESSION")) context.originSession = readEnv("AMUX_SESSION");
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
          const publishedState = (event: typeof AgentEvent.Type) => {
            if (event._tag !== "topic" || event.topic !== SESSION_STATE_TOPIC) return undefined;
            return Option.getOrUndefined(
              Schema.decodeOption(Schema.fromJsonString(ProcessStateSchema))(event.payload),
            );
          };

          // Wait rows: the settled AgentEvent, a bare `{ state }`, or a stall marker.
          const CliWaitResultSchema = Schema.Union([
            AgentEvent,
            Schema.Struct({ state: Schema.String }),
            Schema.Struct({ error: Schema.Literal("agent_prompt_stalled") }),
          ]);
          const encodeWaitResult = (value: typeof CliWaitResultSchema.Type) =>
            Schema.encodeEffect(Schema.fromJsonString(CliWaitResultSchema))(value).pipe(
              Effect.mapError((error) => new Error(String(error))),
            );

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
            return {
              outputs: [
                ...outputs,
                { result: yield* encodeWaitResult({ error: "agent_prompt_stalled" }) },
              ],
            };
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
          return {
            outputs: [
              ...outputs,
              { result: yield* encodeWaitResult(result ?? { state: settled }) },
            ],
          };
        });
      }).pipe(Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))));

      return yield* runResult.pipe(
        Effect.flatMap(({ outputs }) =>
          Effect.gen(function* () {
            for (const { result } of outputs) {
              if (result !== undefined) yield* printBatchResult(result);
            }
            return 0;
          }),
        ),
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
  // stdout is protocol output — command results, --help text, JSON — so
  // logs (plugin-load warnings, etc.) must not interleave with it.
  // BunRuntime.runMain: signal handling + teardown like main.tsx / daemon-main;
  // success value is the CLI exit code.
  BunRuntime.runMain(main().pipe(Effect.provideService(Logger.LogToStderr, true)), {
    teardown: (exit, onExit) => {
      // Teardown's Exit params are swapped vs Effect's (`Exit<E, A>` here means
      // success=E); narrow the CLI exit code explicitly.
      if (Exit.isSuccess(exit) && typeof exit.value === "number") onExit(exit.value);
      else Runtime.defaultTeardown(exit, onExit);
    },
  });
}
