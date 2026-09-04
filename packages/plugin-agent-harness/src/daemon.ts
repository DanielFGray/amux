import { Effect, Layer, Schema as S } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { identifyAgent, readHarnessLog } from "@danielfgray/amux-agent-awareness";
import {
  DaemonCommandsTag,
  CommandError,
  ProcessStateSchema,
  definePlugin,
  registerDaemonCommand,
  type PluginDefinition,
  type DaemonCommandRegistration,
  type JsonValue,
} from "@danielfgray/amux";
import { PermissionDecisionSchema } from "@danielfgray/amux/permission.ts";

const sessionTarget = { session: S.String };
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
interface PromptOptionsDraft {
  id?: string;
  delivery?: "steer" | "queue";
  resume?: boolean;
}

// A session named here has an initial prompt to deliver once its backend
// actually spawns. Spawning a component session is deferred to whichever
// client later calls resumeAgent (daemon.ts:1266), which can be long after
// this reduce runs — core has nothing live to hand the prompt to yet, so it
// waits here instead, and onSessionLive below drains it once the session is.
const pendingPrompts = new Map<string, string>();

const agentNew = {
  tag: "agent.new",
  fields: {
    provider: S.optionalKey(S.String),
    prompt: S.optionalKey(S.String),
  },
  meta: agentPluginMeta("start a coding agent", "workspace", "agent"),
  reduce: (draft, command) => {
    const target = draft.activeWindow();
    if (!target) return;
    // This plugin registers the tag and is the only spawn provider it ever
    // names, so an omitted provider always means its own worker — not a
    // choice callers outside the palette (the CLI, an agent script) have any
    // way to make correctly, since providers are a client-local registry.
    const provider = typeof command.provider === "string" ? command.provider : "native";
    const agent = draft.addSession(target.window, target.space.dir, { provider });
    if (typeof command.prompt === "string") pendingPrompts.set(agent.id, command.prompt);
    const pane = draft.placeSessionPane(target, agent);
    draft.setResult({ session: agent.id, pane });
  },
  onSessionLive: (session, sessionOps) => {
    const prompt = pendingPrompts.get(session.id);
    if (prompt === undefined) return Effect.void;
    pendingPrompts.delete(session.id);
    return sessionOps
      .message(session.id, { _tag: "agent.prompt", text: prompt })
      .pipe(Effect.ignore);
  },
} satisfies DaemonCommandRegistration;

const agentPrompt = {
  tag: "agent.prompt",
  fields: {
    target: S.String,
    text: S.String,
    id: S.optionalKey(S.String),
    delivery: S.optionalKey(S.Literals(["steer", "queue"])),
    resume: S.optionalKey(S.Boolean),
    wait: S.optionalKey(S.Boolean),
    until: S.optionalKey(ProcessStateSchema),
    timeout: S.optionalKey(S.Int.check(S.isGreaterThanOrEqualTo(0))),
  },
  meta: agentPluginMeta("send a prompt to an agent", "session", "agent"),
  run: (command, context) => {
    if (typeof command.target !== "string" || typeof command.text !== "string")
      return Effect.fail(new CommandError({ message: "agent.prompt requires target and text" }));
    const options: PromptOptionsDraft = {};
    if (typeof command.id === "string") options.id = command.id;
    if (command.delivery === "steer" || command.delivery === "queue")
      options.delivery = command.delivery;
    if (typeof command.resume === "boolean") options.resume = command.resume;
    return context.prompt(command.target, command.text, options);
  },
} satisfies DaemonCommandRegistration;

const agentWatch = {
  tag: "agent.watch",
  fields: {
    target: S.String,
    after: S.optionalKey(S.Int.check(S.isGreaterThanOrEqualTo(0))),
  },
  meta: agentPluginMeta("stream durable agent events from a replay cursor", "session", "agent"),
  // The CLI consumes this declaration to parse its arguments, then follows
  // the core-owned event cursor RPC. A batch invocation has no stream return.
  run: () => Effect.void,
} satisfies DaemonCommandRegistration;

const agentInterrupt = {
  tag: "agent.interrupt",
  fields: { ...sessionTarget, reason: S.optionalKey(S.String) },
  meta: agentPluginMeta("interrupt an agent turn", "workspace", "human"),
  reduce: (draft, command) => {
    if (typeof command.session !== "string") return;
    if (typeof command.reason === "string") {
      draft.pushAction({ _tag: "agent.interrupt", agent: command.session, reason: command.reason });
    } else {
      draft.pushAction({ _tag: "agent.interrupt", agent: command.session });
    }
  },
  // Core knows only "deliver this opaque payload to a live session" —
  // `agent.interrupt` is a plugin-owned action tag whose meaning (and wire
  // shape) belongs entirely here, not in core's action vocabulary.
  actions: [
    {
      tag: "agent.interrupt",
      execute: (action, sessionOps) =>
        sessionOps.message(
          action.agent as string,
          action.reason === undefined
            ? { _tag: "agent.interrupt" }
            : { _tag: "agent.interrupt", reason: action.reason },
        ),
    },
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
  reduce: (draft, command) => {
    if (
      typeof command.session === "string" &&
      typeof command.request === "string" &&
      (command.decision === "once" ||
        command.decision === "always" ||
        command.decision === "reject")
    ) {
      if (typeof command.feedback === "string") {
        draft.pushAction({
          _tag: "agent.permission",
          agent: command.session,
          answer: {
            request: command.request,
            decision: command.decision,
            feedback: command.feedback,
          },
        });
      } else {
        draft.pushAction({
          _tag: "agent.permission",
          agent: command.session,
          answer: { request: command.request, decision: command.decision },
        });
      }
    }
  },
  actions: [
    {
      tag: "agent.permission",
      execute: (action, sessionOps) =>
        sessionOps.message(action.agent as string, {
          _tag: "agent.permission",
          ...(action.answer as Record<string, JsonValue>),
        }),
    },
  ],
} satisfies DaemonCommandRegistration;

const agentList = {
  tag: "agent.list",
  fields: {},
  meta: agentPluginMeta("list agents and where they live", "workspace", "agent"),
  reduce: (draft) => draft.setResult(draft.listAgents()),
} satisfies DaemonCommandRegistration;

const agentGet = {
  tag: "agent.get",
  fields: { target: S.String },
  meta: agentPluginMeta("one agent, by its session id", "workspace", "agent"),
  reduce: (draft, command) =>
    draft.setResult(draft.getAgent(typeof command.target === "string" ? command.target : "")),
} satisfies DaemonCommandRegistration;

const agentLogs = {
  tag: "agent.logs",
  fields: { target: S.String, lines: S.optionalKey(S.Int) },
  meta: agentPluginMeta("read the harness durable log", "session", "agent"),
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
    const harness = found.session.declaredAgent ?? identifyAgent(found.session.cmd ?? []);
    return readHarnessLog(harness ?? undefined, found.session.cwd, lines).pipe(
      Effect.provide(BunFileSystem.layer.pipe(Layer.provideMerge(BunPath.layer))),
    );
  },
} satisfies DaemonCommandRegistration;

export const agentHarnessDaemonCommands: readonly DaemonCommandRegistration[] = [
  agentNew,
  agentPrompt,
  agentWatch,
  agentInterrupt,
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
