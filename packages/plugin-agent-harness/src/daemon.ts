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
interface InterruptActionDraft {
  _tag: "interrupt";
  agent: string;
  reason?: string;
}
interface PermissionAnswerDraft {
  request: string;
  decision: "once" | "always" | "reject";
  feedback?: string;
}

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
    const provider = typeof command.provider === "string" ? command.provider : undefined;
    const prompt = typeof command.prompt === "string" ? command.prompt : undefined;
    const agent = draft.addSession(target.window, target.space.dir, { provider, prompt });
    const pane = draft.placeSessionPane(target, agent);
    draft.setResult({ session: agent.id, pane });
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
    if (typeof command.session === "string") {
      const action: InterruptActionDraft = {
        _tag: "interrupt",
        agent: command.session,
      };
      if (typeof command.reason === "string") action.reason = command.reason;
      draft.pushAction(action);
    }
  },
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
      let answer: PermissionAnswerDraft = {
        request: command.request,
        decision: command.decision,
      };
      if (typeof command.feedback === "string") answer = { ...answer, feedback: command.feedback };
      draft.pushAction({ _tag: "decide", agent: command.session, answer });
    }
  },
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
