import { Effect, Layer, Option, Schema as S } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
  configHome,
  identifyAgent,
  loadRegistry,
  readHarnessLog,
} from "@danielfgray/amux-agent-awareness";
import {
  AgentGetResultSchema,
  AgentListResultSchema,
  CommandError,
  DaemonCommandsTag,
  DaemonSessions,
  WorkspaceTransactionError,
  creationResultSchema,
  defineDaemonCommand,
  definePlugin,
  definePluginAction,
  defineSessionProvider,
  encodeOwner,
  makeSessionId,
  registerDaemonCommand,
  type PluginDefinition,
  type PromptOptions,
} from "@danielfgray/amux";
import { PermissionDecisionSchema } from "@danielfgray/amux/permission.ts";
import { NativeControl } from "./native-control.ts";
import {
  AgentCompactArgs,
  AgentGetArgs,
  AgentInterruptArgs,
  AgentListArgs,
  AgentLogsArgs,
  AgentNewArgs,
  AgentPermissionArgs,
  AgentPromptArgs,
  AgentWatchArgs,
} from "./command-args.ts";

const encodeNativeControl = encodeOwner(NativeControl, "NativeControl");

const deliverNativeControl = Effect.fnUntraced(function* (agent: string, control: NativeControl) {
  const sessions = yield* DaemonSessions;
  const message = yield* encodeNativeControl(control).pipe(
    Effect.mapError((error) => new WorkspaceTransactionError({ message: error.message })),
  );
  yield* sessions.message(agent, message);
});

const agentPluginMeta = (
  desc: string,
  target: "workspace" | "session",
  exposure: "agent" | "human",
) => ({
  desc,
  group: "agents",
  target,
  exposure,
});
type PromptOptionsDraft = {
  -readonly [K in keyof PromptOptions]?: PromptOptions[K];
};

const AgentInterruptAction = S.TaggedStruct("agent.interrupt", {
  agent: S.String,
  reason: S.optionalKey(S.String),
});
const AgentCompactAction = S.TaggedStruct("agent.compact", {
  agent: S.String,
  instructions: S.optionalKey(S.String),
});
const AgentPermissionAction = S.TaggedStruct("agent.permission", {
  agent: S.String,
  answer: S.Struct({
    request: S.String,
    decision: PermissionDecisionSchema,
    feedback: S.optionalKey(S.String),
  }),
});

const nativeProvider = defineSessionProvider("native", NativeControl);

const agentNew = defineDaemonCommand({
  tag: "agent.new",
  fields: AgentNewArgs,
  meta: agentPluginMeta("start a coding agent", "workspace", "agent"),
  resources: (args) =>
    [args.provider, args.resumeFrom].flatMap((value) => (value !== undefined ? [value] : [])),
  result: creationResultSchema("agent.new"),
  providers: [nativeProvider],
  reduce: ({ command, context, reads, build }) =>
    Effect.gen(function* () {
      const target = reads.activeWindow;
      if (target === null) return build.answer([]);
      // This plugin registers the tag and is the only spawn provider it ever
      // names, so an omitted provider always means its own worker — not a
      // choice callers outside the palette (the CLI, an agent script) have any
      // way to make correctly, since providers are a client-local registry.
      const provider = command.provider ?? "native";
      const resumeFrom =
        command.resumeFrom !== undefined && command.resumeFrom.length > 0
          ? command.resumeFrom
          : undefined;
      // Same id → same AgentLog + project-store conversation. Copying onto a
      // fresh id left the chat pane blank (transcript is the durable log).
      if (resumeFrom !== undefined && reads.sessionsById[resumeFrom] !== undefined) {
        return build.answer([]);
      }
      // From inside a pane (CLI / shell with AMUX_PANE_ID, or the focused leaf
      // from the client): replace that leaf and keep the displaced PTY alive.
      // Palette / remote call without a caller: split. `split: true` always splits.
      // Cite: packages/editor/src/daemon.ts editorOpen.
      const sessionId = resumeFrom ?? (yield* makeSessionId);
      const windowTarget = { space: target.space, window: target.window };
      const firstMessage =
        command.prompt !== undefined
          ? yield* nativeProvider.message({
              _tag: "agent.prompt" as const,
              text: command.prompt,
            })
          : undefined;
      const add =
        firstMessage === undefined
          ? build.sessionAdd({
              id: sessionId,
              target: windowTarget,
              dir: target.dir,
              provider,
            })
          : build.sessionAdd({
              id: sessionId,
              target: windowTarget,
              dir: target.dir,
              provider,
              firstMessage,
            });
      if (command.split !== true && context.pane !== undefined) {
        const pane = context.pane;
        return build.answer([
          add,
          build.sessionPlace({
            mode: "replace",
            target: windowTarget,
            session: sessionId,
          }),
          yield* build.result({ session: sessionId, pane }),
        ]);
      }
      const pane = build.nextPaneId(target.space);
      return build.answer([
        add,
        build.sessionPlace({
          mode: "split",
          pane,
          target: windowTarget,
          session: sessionId,
        }),
        yield* build.result({ session: sessionId, pane }),
      ]);
    }),
});

const agentPrompt = defineDaemonCommand({
  tag: "agent.prompt",
  fields: AgentPromptArgs,
  meta: agentPluginMeta("send a prompt to an agent", "session", "agent"),
  resources: (args) => [args.target],
  run: (command, _context) =>
    Effect.gen(function* () {
      const options: PromptOptionsDraft = {};
      if (command.id !== undefined) options.id = command.id;
      if (command.delivery === "steer" || command.delivery === "queue")
        options.delivery = command.delivery;
      if (command.resume !== undefined) options.resume = command.resume;
      if (command.replace !== undefined) options.replace = command.replace;
      const sessions = yield* DaemonSessions;
      return yield* sessions
        .prompt(command.target, command.text, options)
        .pipe(Effect.mapError((error) => new CommandError({ message: error.message })));
    }),
});

const agentWatch = defineDaemonCommand({
  tag: "agent.watch",
  fields: AgentWatchArgs,
  meta: agentPluginMeta("stream durable agent events from a replay cursor", "session", "agent"),
  resources: (args) => [args.target],
  // The CLI consumes this declaration to parse its arguments, then follows
  // the core-owned event cursor RPC. A batch invocation has no stream return.
  run: () => Effect.void,
});

const interruptAction = definePluginAction({
  tag: "agent.interrupt",
  payload: AgentInterruptAction,
  execute: (action) => {
    const control: NativeControl =
      action.reason === undefined
        ? { _tag: "agent.interrupt" }
        : { _tag: "agent.interrupt", reason: action.reason };
    return deliverNativeControl(action.agent, control);
  },
});

const agentInterrupt = defineDaemonCommand({
  tag: "agent.interrupt",
  fields: AgentInterruptArgs,
  meta: agentPluginMeta("interrupt an agent turn", "workspace", "human"),
  resources: (args) => [args.target],
  actions: [interruptAction],
  reduce: ({ command, build }) =>
    Effect.gen(function* () {
      const action =
        command.reason === undefined
          ? { _tag: "agent.interrupt" as const, agent: command.target }
          : { _tag: "agent.interrupt" as const, agent: command.target, reason: command.reason };
      return build.answer([yield* interruptAction.push(action)]);
    }),
});

const compactAction = definePluginAction({
  tag: "agent.compact",
  payload: AgentCompactAction,
  execute: (action) => {
    const control: NativeControl =
      action.instructions === undefined
        ? { _tag: "agent.compact" }
        : { _tag: "agent.compact", instructions: action.instructions };
    return deliverNativeControl(action.agent, control);
  },
});

const agentCompact = defineDaemonCommand({
  tag: "agent.compact",
  fields: AgentCompactArgs,
  meta: agentPluginMeta(
    "compact the native agent conversation to free context",
    "workspace",
    "human",
  ),
  resources: (args) => [args.target],
  actions: [compactAction],
  reduce: ({ command, build }) =>
    Effect.gen(function* () {
      const action =
        command.instructions === undefined
          ? { _tag: "agent.compact" as const, agent: command.target }
          : {
              _tag: "agent.compact" as const,
              agent: command.target,
              instructions: command.instructions,
            };
      return build.answer([yield* compactAction.push(action)]);
    }),
});

const permissionAction = definePluginAction({
  tag: "agent.permission",
  payload: AgentPermissionAction,
  execute: (action) => {
    const control: NativeControl =
      action.answer.feedback === undefined
        ? {
            _tag: "agent.permission",
            request: action.answer.request,
            decision: action.answer.decision,
          }
        : {
            _tag: "agent.permission",
            request: action.answer.request,
            decision: action.answer.decision,
            feedback: action.answer.feedback,
          };
    return deliverNativeControl(action.agent, control);
  },
});

const agentPermission = defineDaemonCommand({
  tag: "agent.permission",
  fields: AgentPermissionArgs,
  meta: agentPluginMeta("answer an agent's permission request", "workspace", "human"),
  resources: (args) => [args.target],
  actions: [permissionAction],
  reduce: ({ command, build }) =>
    Effect.gen(function* () {
      const answer =
        command.feedback === undefined
          ? { request: command.request, decision: command.decision }
          : {
              request: command.request,
              decision: command.decision,
              feedback: command.feedback,
            };
      return build.answer([
        yield* permissionAction.push({
          _tag: "agent.permission",
          agent: command.target,
          answer,
        }),
      ]);
    }),
});

const agentList = defineDaemonCommand({
  tag: "agent.list",
  fields: AgentListArgs,
  meta: agentPluginMeta("list agents and where they live", "workspace", "agent"),
  resources: () => [],
  result: AgentListResultSchema,
  reduce: ({ reads, build }) =>
    Effect.gen(function* () {
      return build.answer([yield* build.result(reads.agents)]);
    }),
});

const agentGet = defineDaemonCommand({
  tag: "agent.get",
  fields: AgentGetArgs,
  meta: agentPluginMeta("one agent, by its session id", "workspace", "agent"),
  resources: (args) => [args.target],
  result: AgentGetResultSchema,
  reduce: ({ command, reads, build }) =>
    Effect.gen(function* () {
      const agent = reads.agents.find((entry) => entry.id === command.target) ?? null;
      return build.answer([yield* build.result(agent)]);
    }),
});

const agentLogs = defineDaemonCommand({
  tag: "agent.logs",
  fields: AgentLogsArgs,
  meta: agentPluginMeta("read the harness durable log", "session", "agent"),
  resources: (args) => [args.target],
  run: (command, context) => {
    const found = context.snapshot.spaces
      .flatMap((space) => space.windows.map((window) => ({ space, window })))
      .flatMap(({ space, window }) =>
        window.sessions.map((session) => ({ space, window, session })),
      )
      .find(({ session }) => session.id === command.target);
    if (!found)
      return Effect.fail(
        new CommandError({ message: `session '${command.target}' does not exist` }),
      );
    const lines = command.lines !== undefined ? command.lines : 50;
    // A component session's declaredAgent is a spawn-provider id (this
    // plugin's own "native", or another plugin's), not a claim that some
    // real CLI process wrote a log on disk — reading one by that name would
    // risk matching an unrelated real session that happens to share both a
    // provider name and this cwd. Only a pty session's declaredAgent (set by
    // detecting its actual argv) names a process this reader can trust.
    if (found.session.kind === "component") return Effect.succeed([]);
    return configHome.pipe(
      Effect.orDie,
      Effect.flatMap(loadRegistry),
      Effect.provide(BunFileSystem.layer.pipe(Layer.provideMerge(BunPath.layer))),
      Effect.flatMap((registry) =>
        Option.match(
          Option.orElse(Option.fromNullishOr(found.session.declaredAgent), () =>
            identifyAgent(registry, found.session.cmd ?? []),
          ),
          {
            onNone: () => Effect.succeed([]),
            onSome: (harness) =>
              readHarnessLog(harness, found.session.cwd, lines).pipe(
                Effect.provide(BunFileSystem.layer.pipe(Layer.provideMerge(BunPath.layer))),
              ),
          },
        ),
      ),
    );
  },
});

export const agentHarnessDaemonCommands = [
  agentNew,
  agentPrompt,
  agentWatch,
  agentInterrupt,
  agentCompact,
  agentPermission,
  agentList,
  agentGet,
  agentLogs,
] as const;

export const agentHarnessDaemonPlugin: PluginDefinition = definePlugin({
  id: "amux.agent-harness.daemon",
  inject: [DaemonCommandsTag],
  effect: () =>
    Effect.gen(function* () {
      for (const registration of agentHarnessDaemonCommands)
        yield* registerDaemonCommand(registration);
    }),
});

export default agentHarnessDaemonPlugin;
