import { Effect, Layer, Option, Result, Schema as S } from "effect";
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
  JsonValueSchema,
  ProcessStateSchema,
  WorkspaceTransactionError,
  commandResultCodec,
  creationResultSchema,
  definePlugin,
  definePluginAction,
  registerDaemonCommand,
  sessionProviderMessageCodec,
  type DaemonCommandRegistration,
  type PluginDefinition,
  type JsonValue,
  type PromptOptions,
} from "@danielfgray/amux";
import { PermissionDecisionSchema } from "@danielfgray/amux/permission.ts";
import { NativeControl } from "./native-control.ts";

const encodeNativeControl = (
  message: NativeControl,
): Effect.Effect<JsonValue, WorkspaceTransactionError> =>
  Effect.suspend(() => {
    const encoded = S.encodeResult(NativeControl)(message);
    if (Result.isFailure(encoded)) {
      return Effect.fail(new WorkspaceTransactionError({ message: "NativeControl encode failed" }));
    }
    const wire = S.decodeUnknownResult(JsonValueSchema)(encoded.success);
    if (Result.isFailure(wire)) {
      return Effect.fail(new WorkspaceTransactionError({ message: "NativeControl encode failed" }));
    }
    return Effect.succeed(wire.success);
  });

const sessionTarget = { target: S.String };
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

const agentNew = {
  tag: "agent.new",
  fields: {
    provider: S.optionalKey(S.String),
    prompt: S.optionalKey(S.String),
    // Force a sibling split even when invoked from a pane (AMUX_PANE_ID /
    // focused leaf). Same flag as editor.open.
    split: S.optionalKey(S.Boolean),
    /** Resume this prior agent id: recreate it in the workspace so its
     *  conversation + AgentLog (UI transcript) both come back. */
    resumeFrom: S.optionalKey(S.String),
  },
  meta: agentPluginMeta("start a coding agent", "workspace", "agent"),
  resources: (args) =>
    [args.provider, args.resumeFrom].flatMap((value) => (typeof value === "string" ? [value] : [])),
  result: commandResultCodec(creationResultSchema("agent.new")),
  providerMessages: [sessionProviderMessageCodec("native", NativeControl)],
  reduce: ({ command, context, reads }) =>
    Effect.sync(() => {
      const target = reads.activeWindow;
      if (!target) return { changes: [] };
      // This plugin registers the tag and is the only spawn provider it ever
      // names, so an omitted provider always means its own worker — not a
      // choice callers outside the palette (the CLI, an agent script) have any
      // way to make correctly, since providers are a client-local registry.
      const provider = typeof command.provider === "string" ? command.provider : "native";
      const resumeFrom =
        typeof command.resumeFrom === "string" && command.resumeFrom.length > 0
          ? command.resumeFrom
          : undefined;
      // Same id → same AgentLog + project-store conversation. Copying onto a
      // fresh id left the chat pane blank (transcript is the durable log).
      if (resumeFrom !== undefined && reads.sessionsById[resumeFrom] !== undefined) {
        return { changes: [] };
      }
      // session.add stores firstMessage; ResumeAgent delivers it once after
      // spawn and clears the field (daemon.ts ResumeAgent).
      const firstMessage: JsonValue | undefined =
        typeof command.prompt === "string"
          ? { _tag: "agent.prompt", text: command.prompt }
          : undefined;
      // From inside a pane (CLI / shell with AMUX_PANE_ID, or the focused leaf
      // from the client): replace that leaf and keep the displaced PTY alive.
      // Palette / remote call without a caller: split. `split: true` always splits.
      // Cite: packages/editor/src/daemon.ts editorOpen.
      const mode =
        command.split === true ? "split" : context.pane !== undefined ? "replace" : "split";
      const add = {
        _tag: "session.add" as const,
        ref: "session",
        target: { space: target.space, window: target.window },
        dir: target.dir,
        provider,
      };
      if (resumeFrom !== undefined) Object.assign(add, { id: resumeFrom });
      if (firstMessage !== undefined) Object.assign(add, { firstMessage });
      return {
        changes: [
          add,
          {
            _tag: "session.place" as const,
            ref: "pane",
            target: { space: target.space, window: target.window },
            session: { _tag: "WorkspaceRef" as const, ref: "session" },
            mode,
          },
          {
            _tag: "result.set" as const,
            result: {
              session: { _tag: "WorkspaceRef", ref: "session" },
              pane: { _tag: "WorkspaceRef", ref: "pane" },
            } satisfies JsonValue,
          },
        ],
      };
    }),
} satisfies DaemonCommandRegistration;

const agentPrompt = {
  tag: "agent.prompt",
  fields: {
    target: S.String,
    text: S.String,
    id: S.optionalKey(S.String),
    delivery: S.optionalKey(S.Literals(["steer", "queue"])),
    resume: S.optionalKey(S.Boolean),
    replace: S.optionalKey(S.String),
    wait: S.optionalKey(S.Boolean),
    until: S.optionalKey(ProcessStateSchema),
    timeout: S.optionalKey(S.Int.check(S.isGreaterThanOrEqualTo(0))),
  },
  meta: agentPluginMeta("send a prompt to an agent", "session", "agent"),
  resources: (args) => (typeof args.target === "string" ? [args.target] : []),
  run: (command, _context) =>
    Effect.gen(function* () {
      if (typeof command.target !== "string" || typeof command.text !== "string")
        return yield* new CommandError({ message: "agent.prompt requires target and text" });
      const options: PromptOptionsDraft = {};
      if (typeof command.id === "string") options.id = command.id;
      if (command.delivery === "steer" || command.delivery === "queue")
        options.delivery = command.delivery;
      if (typeof command.resume === "boolean") options.resume = command.resume;
      if (typeof command.replace === "string") options.replace = command.replace;
      const sessions = yield* DaemonSessions;
      return yield* sessions
        .prompt(command.target, command.text, options)
        .pipe(Effect.mapError((error) => new CommandError({ message: error.message })));
    }),
} satisfies DaemonCommandRegistration;

const agentWatch = {
  tag: "agent.watch",
  fields: {
    target: S.String,
    after: S.optionalKey(S.Int.check(S.isGreaterThanOrEqualTo(0))),
  },
  meta: agentPluginMeta("stream durable agent events from a replay cursor", "session", "agent"),
  resources: (args) => (typeof args.target === "string" ? [args.target] : []),
  // The CLI consumes this declaration to parse its arguments, then follows
  // the core-owned event cursor RPC. A batch invocation has no stream return.
  run: () => Effect.void,
} satisfies DaemonCommandRegistration;

const agentInterrupt = {
  tag: "agent.interrupt",
  fields: { ...sessionTarget, reason: S.optionalKey(S.String) },
  meta: agentPluginMeta("interrupt an agent turn", "workspace", "human"),
  resources: (args) => (typeof args.target === "string" ? [args.target] : []),
  reduce: ({ command }) =>
    Effect.sync(() => {
      if (typeof command.target !== "string") return { changes: [] };
      const action: JsonValue =
        typeof command.reason === "string"
          ? { _tag: "agent.interrupt", agent: command.target, reason: command.reason }
          : { _tag: "agent.interrupt", agent: command.target };
      return {
        changes: [{ _tag: "action.push" as const, action }],
      };
    }),
  actions: [
    definePluginAction({
      tag: "agent.interrupt",
      payload: AgentInterruptAction,
      execute: (action) => {
        const control: NativeControl =
          action.reason === undefined
            ? { _tag: "agent.interrupt" }
            : { _tag: "agent.interrupt", reason: action.reason };
        return Effect.gen(function* () {
          const sessions = yield* DaemonSessions;
          const message = yield* encodeNativeControl(control);
          yield* sessions.message(action.agent, message);
        });
      },
    }),
  ],
} satisfies DaemonCommandRegistration;

const agentCompact = {
  tag: "agent.compact",
  fields: {
    ...sessionTarget,
    instructions: S.optionalKey(S.String),
  },
  meta: agentPluginMeta(
    "compact the native agent conversation to free context",
    "workspace",
    "human",
  ),
  resources: (args) => (typeof args.target === "string" ? [args.target] : []),
  reduce: ({ command }) =>
    Effect.sync(() => {
      if (typeof command.target !== "string") return { changes: [] };
      const action: JsonValue =
        typeof command.instructions === "string"
          ? {
              _tag: "agent.compact",
              agent: command.target,
              instructions: command.instructions,
            }
          : { _tag: "agent.compact", agent: command.target };
      return {
        changes: [{ _tag: "action.push" as const, action }],
      };
    }),
  actions: [
    definePluginAction({
      tag: "agent.compact",
      payload: AgentCompactAction,
      execute: (action) => {
        const control: NativeControl =
          action.instructions === undefined
            ? { _tag: "agent.compact" }
            : { _tag: "agent.compact", instructions: action.instructions };
        return Effect.gen(function* () {
          const sessions = yield* DaemonSessions;
          const message = yield* encodeNativeControl(control);
          yield* sessions.message(action.agent, message);
        });
      },
    }),
  ],
} satisfies DaemonCommandRegistration;

const agentPermission = {
  tag: "agent.permission",
  fields: {
    ...sessionTarget,
    request: S.String,
    decision: PermissionDecisionSchema,
    feedback: S.optionalKey(S.String),
  },
  meta: agentPluginMeta("answer an agent's permission request", "workspace", "human"),
  resources: (args) => (typeof args.target === "string" ? [args.target] : []),
  reduce: ({ command }) =>
    Effect.sync(() => {
      if (
        typeof command.target !== "string" ||
        typeof command.request !== "string" ||
        (command.decision !== "once" &&
          command.decision !== "always" &&
          command.decision !== "reject")
      ) {
        return { changes: [] };
      }
      const answer: JsonValue =
        typeof command.feedback === "string"
          ? {
              request: command.request,
              decision: command.decision,
              feedback: command.feedback,
            }
          : { request: command.request, decision: command.decision };
      return {
        changes: [
          {
            _tag: "action.push" as const,
            action: {
              _tag: "agent.permission",
              agent: command.target,
              answer,
            },
          },
        ],
      };
    }),
  actions: [
    definePluginAction({
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
        return Effect.gen(function* () {
          const sessions = yield* DaemonSessions;
          const message = yield* encodeNativeControl(control);
          yield* sessions.message(action.agent, message);
        });
      },
    }),
  ],
} satisfies DaemonCommandRegistration;

const agentList = {
  tag: "agent.list",
  fields: {},
  meta: agentPluginMeta("list agents and where they live", "workspace", "agent"),
  resources: () => [],
  result: commandResultCodec(AgentListResultSchema),
  reduce: ({ reads }) =>
    Effect.succeed({
      changes: [{ _tag: "result.set" as const, result: reads.agents }],
    }),
} satisfies DaemonCommandRegistration;

const agentGet = {
  tag: "agent.get",
  fields: { target: S.String },
  meta: agentPluginMeta("one agent, by its session id", "workspace", "agent"),
  resources: (args) => (typeof args.target === "string" ? [args.target] : []),
  result: commandResultCodec(AgentGetResultSchema),
  reduce: ({ command, reads }) =>
    Effect.sync(() => {
      const target = typeof command.target === "string" ? command.target : "";
      const agent = reads.agents.find((entry) => entry.id === target) ?? null;
      return {
        changes: [{ _tag: "result.set" as const, result: agent }],
      };
    }),
} satisfies DaemonCommandRegistration;

const agentLogs = {
  tag: "agent.logs",
  fields: { target: S.String, lines: S.optionalKey(S.Int) },
  meta: agentPluginMeta("read the harness durable log", "session", "agent"),
  resources: (args) => (typeof args.target === "string" ? [args.target] : []),
  run: (command, context) => {
    if (typeof command.target !== "string")
      return Effect.fail(new CommandError({ message: "agent.logs requires target" }));
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
    const lines =
      typeof command.lines === "number" && Number.isSafeInteger(command.lines) ? command.lines : 50;
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
} satisfies DaemonCommandRegistration;

export const agentHarnessDaemonCommands: readonly DaemonCommandRegistration[] = [
  agentNew,
  agentPrompt,
  agentWatch,
  agentInterrupt,
  agentCompact,
  agentPermission,
  agentList,
  agentGet,
  agentLogs,
];

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
