import { Chat, LanguageModel, Prompt } from "effect/unstable/ai";
import { BunFileSystem } from "@effect/platform-bun";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Path from "effect/Path";
import { Effect, Layer, Match, Option, Ref, Schema as S, Stream } from "effect";
import { Default as IntegrationDefault, Service as Integration } from "./integration.ts";
import * as ModelCatalog from "./model-catalog.ts";
import { configDir, loadConfig } from "@danielfgray/amux/config.ts";
import { coerceOption } from "@danielfgray/amux";
import { AGENT_HARNESS_OPTIONS, parseModelReference, type ApprovalMode } from "./options.ts";
import { resolveCompactionStrategy } from "./compaction-strategies.ts";
import { initialContext } from "./context.ts";
import {
  AttachFrame,
  encodeAttachFrame,
  type AgentDelta,
  type AgentEventPayload,
} from "@danielfgray/amux/protocol";
import { emit as toAgentMessage, type HarnessEvent } from "./protocol.ts";
import { agentToolkit } from "./tools.ts";
import { makePermissionGate, PermissionGateTag } from "./permission.ts";
import { DEFAULT_RULES, PermissionDecisionSchema } from "@danielfgray/amux/permission.ts";
import { projectRoot } from "@danielfgray/amux/git.ts";
import {
  layer as projectStoreLayer,
  Service as ProjectStore,
} from "@danielfgray/amux/project-store.ts";
import {
  AgentWorkerError,
  closeOpenToolCalls,
  makeAgentWorker,
  sanitizeAgentError,
} from "./worker.ts";
import {
  DocumentService,
  LspService,
  catalogWithOverrides,
  loadCatalogOverrides,
  makeDocumentService,
} from "@danielfgray/amux-plugin-lsp";
import { PREWALK_HANDOFF_TOPIC, decidePrewalkHandoff, planPrewalk } from "./prewalk.ts";
import { switchableLanguageModel } from "./switchable-model.ts";
import { makeHarnessHooks } from "./hooks.ts";

// --- Process entry point ---

// @effect-diagnostics-next-line processEnv:off -- bootstrap read before any Effect runs.
const session = process.env.AMUX_SESSION ?? process.env.AMUX_AGENT_ID;

/** The native harness's private component-control protocol. Core transports
 * this as `session.message`; it never needs to understand these verbs. */
const NativeControl = S.Union([
  S.TaggedStruct("agent.prompt", {
    text: S.String,
    id: S.optional(S.String),
    delivery: S.optional(S.Literals(["steer", "queue"])),
    resume: S.optional(S.Boolean),
    replace: S.optional(S.String),
  }),
  S.TaggedStruct("agent.interrupt", { reason: S.optional(S.String) }),
  S.TaggedStruct("agent.permission", {
    request: S.String,
    decision: PermissionDecisionSchema,
    feedback: S.optional(S.String),
  }),
  S.TaggedStruct("agent.compact", {
    instructions: S.optional(S.String),
  }),
]);
type NativeControl = typeof NativeControl.Type;
const decodeNativeControl = S.decodeUnknownOption(NativeControl);

if (!import.meta.main) {
  // Imported as a module — exports only, don't validate env or start the daemon.
} else if (!session) throw new Error("AMUX_SESSION is required");
else {
  // The turn a permission request belongs to is the one currently executing.
  let turn = "";
  // A live fragment (`agent.delta`) is already a full wire frame; a durable
  // payload needs the daemon to assign it a place in the order, so it goes out
  // wrapped as `agent.emit` instead of being written to stdout as-is.
  const emit = (frame: AgentEventPayload | AgentDelta) =>
    Effect.sync(() =>
      process.stdout.write(
        encodeAttachFrame(
          frame._tag === "agent.delta"
            ? frame
            : ({ _tag: "agent.emit", event: frame } as AttachFrame),
        ),
      ),
    );
  const emitError = (message: string) =>
    emit(toAgentMessage(session, { _tag: "agent.error", message } satisfies HarnessEvent));

  // @effect-diagnostics-next-line processEnv:off -- bootstrap read before any Effect runs.
  const workspace = process.env.AMUX_AGENT_CWD ?? process.cwd();

  const program = Effect.gen(function* () {
    const config = yield* loadConfig();
    const modelSpec = AGENT_HARNESS_OPTIONS["agent.model"];
    const modelReference = (coerceOption(modelSpec, config.options["agent.model"]) ??
      modelSpec.default) as string;
    const model = parseModelReference(modelReference);
    if (!model)
      return yield* Effect.fail(`invalid agent.model '${modelReference}', expected provider/model`);
    const { providerID } = model;
    const approvalModeSpec = AGENT_HARNESS_OPTIONS["agent.approvalMode"];
    const approvalMode = (coerceOption(approvalModeSpec, config.options["agent.approvalMode"]) ??
      approvalModeSpec.default) as ApprovalMode;
    const bashInterceptorSpec = AGENT_HARNESS_OPTIONS["agent.bashInterceptor"];
    const bashInterceptor = (coerceOption(
      bashInterceptorSpec,
      config.options["agent.bashInterceptor"],
    ) ?? bashInterceptorSpec.default) as boolean;
    const thinkingSpec = AGENT_HARNESS_OPTIONS["agent.thinking"];
    const thinking = (coerceOption(thinkingSpec, config.options["agent.thinking"]) ??
      thinkingSpec.default) as string;
    const thinkingBudgetSpec = AGENT_HARNESS_OPTIONS["agent.thinkingBudget"];
    const thinkingBudget = (coerceOption(
      thinkingBudgetSpec,
      config.options["agent.thinkingBudget"],
    ) ?? thinkingBudgetSpec.default) as number;

    const autoCompact = (coerceOption(
      AGENT_HARNESS_OPTIONS["agent.autoCompact"],
      config.options["agent.autoCompact"],
    ) ?? AGENT_HARNESS_OPTIONS["agent.autoCompact"].default) as boolean;
    const autoCompactAt = (coerceOption(
      AGENT_HARNESS_OPTIONS["agent.autoCompactAt"],
      config.options["agent.autoCompactAt"],
    ) ?? AGENT_HARNESS_OPTIONS["agent.autoCompactAt"].default) as number;
    const compactKeepRecent = (coerceOption(
      AGENT_HARNESS_OPTIONS["agent.compactKeepRecent"],
      config.options["agent.compactKeepRecent"],
    ) ?? AGENT_HARNESS_OPTIONS["agent.compactKeepRecent"].default) as number;
    const compactStrategy = (coerceOption(
      AGENT_HARNESS_OPTIONS["agent.compactStrategy"],
      config.options["agent.compactStrategy"],
    ) ?? AGENT_HARNESS_OPTIONS["agent.compactStrategy"].default) as string;

    const integration = yield* Integration;
    const resolveModelService = Effect.fnUntraced(function* (reference: string) {
      const parsed = parseModelReference(reference);
      if (!parsed) return undefined;
      const layer = yield* integration.model(
        parsed.providerID,
        parsed.modelID,
        thinking,
        thinkingBudget,
      );
      if (!layer) return undefined;
      return yield* LanguageModel.LanguageModel.pipe(Effect.provide(layer));
    });

    const strongService = yield* resolveModelService(modelReference);
    if (!strongService) return yield* Effect.fail(`credential missing for ${providerID}`);

    const prewalkSpec = AGENT_HARNESS_OPTIONS["agent.prewalk"];
    const prewalkEnabled = (coerceOption(prewalkSpec, config.options["agent.prewalk"]) ??
      prewalkSpec.default) as boolean;
    const prewalkModelSpec = AGENT_HARNESS_OPTIONS["agent.prewalkModel"];
    const prewalkModelReference = (coerceOption(
      prewalkModelSpec,
      config.options["agent.prewalkModel"],
    ) ?? prewalkModelSpec.default) as string;

    let exploreService = strongService;
    let exploreAvailable = false;
    if (prewalkEnabled && prewalkModelReference !== modelReference) {
      const explore = yield* resolveModelService(prewalkModelReference);
      if (explore) {
        exploreService = explore;
        exploreAvailable = true;
      } else {
        yield* Effect.logWarning(
          `prewalk skipped: could not resolve agent.prewalkModel '${prewalkModelReference}'`,
        );
      }
    }

    const plan = planPrewalk({
      enabled: prewalkEnabled,
      strongModel: modelReference,
      prewalkModel: prewalkModelReference,
      exploreAvailable,
    });
    const activeModel = yield* Ref.make(plan.armed ? exploreService : strongService);
    const handedOff = yield* Ref.make(false);
    const modelLayer = Layer.succeed(
      LanguageModel.LanguageModel,
      switchableLanguageModel(activeModel),
    );
    // Approvals belong to the repository, not to this worktree or this pane, so
    // the store is opened on the project root that every worktree shares.
    const root = yield* projectRoot(workspace);
    yield* Effect.gen(function* () {
      const store = yield* ProjectStore;
      const hooks = makeHarnessHooks();
      yield* hooks.emit({
        _tag: "before_agent_start",
        session,
        model: modelReference,
      });
      const gate = yield* makePermissionGate({
        session,
        turn: Effect.sync(() => turn),
        // Defaults, then the config file, then what the user approved here: the
        // order is the precedence, and `evaluate` reads it as last-match-wins.
        rules: [...DEFAULT_RULES, ...config.permissions, ...(yield* store.rules)],
        store,
        emit,
        mode: approvalMode,
        hooks,
      });
      const searchPlugin = yield* Effect.promise(
        () => import("@danielfgray/amux-plugin-search/agent"),
      ).pipe(Effect.orElseSucceed(() => undefined));
      const search = searchPlugin
        ? yield* searchPlugin
            .makeAgentSearch({ root: workspace, session })
            .pipe(Effect.orElseSucceed(() => undefined))
        : undefined;
      // LSP lives in this worker, not the client plugin host: the host is
      // client-only. Same LspService type the editor consumes.
      const lsp = yield* Effect.gen(function* () {
        const documents = yield* makeDocumentService({ session }).pipe(
          Effect.provide(BunServices.layer),
        );
        const overrides = yield* loadCatalogOverrides(`${yield* configDir}/amux`).pipe(
          Effect.provide(BunServices.layer),
          Effect.orElseSucceed(() => ({ languages: {} })),
        );
        const catalog = catalogWithOverrides(overrides);
        const service = yield* LspService.make({ catalog }).pipe(
          Effect.provideService(DocumentService, documents),
          Effect.provide(BunServices.layer),
        );
        return { service, catalog };
      }).pipe(Effect.orElseSucceed(() => undefined));
      const toolkit = agentToolkit(
        workspace,
        { session, store },
        { search, lsp, bashInterceptor },
      ).pipe(Effect.provideService(PermissionGateTag, gate));
      // Chat owns the conversation: history, tool-call/result pairing and the
      // provider message shape are all its job, not ours. A resumed chat keeps
      // whatever system message it was created with; only a brand-new one needs
      // one built, since initialContext bakes in a date and a resumed session's
      // history must not silently drift to today's.
      const savedConversation = yield* store.conversation(session);
      const chat =
        savedConversation === undefined
          ? yield* Chat.fromPrompt(
              Prompt.make([
                Prompt.makeMessage("system", { content: yield* initialContext({ workspace }) }),
              ]),
            )
          : yield* Chat.fromJson(savedConversation);
      // A daemon or client death can leave a persisted tool call without a
      // result. Repair it before the first provider request, never by replay.
      yield* closeOpenToolCalls(chat);
      const worker = yield* makeAgentWorker({
        session,
        chat,
        emit,
        toolkit,
        inbox: store,
        compaction: {
          auto: autoCompact,
          atPercent: autoCompactAt,
          keepRecentTokens: compactKeepRecent,
          strategy: resolveCompactionStrategy(compactStrategy),
          contextLimit: yield* Effect.gen(function* () {
            const catalog = yield* ModelCatalog.Service;
            const entry = yield* catalog.model(model.providerID, model.modelID);
            return entry?.limit.context;
          }).pipe(Effect.orElseSucceed(() => undefined)),
        },
        persist: chat.exportJson.pipe(
          Effect.flatMap((conversation) => store.saveConversation(session, conversation)),
          Effect.ignore,
        ),
        onTurnStart: (turnId) =>
          Effect.sync(() => {
            turn = turnId;
          }),
        onToolResult: (tool, succeeded) =>
          Effect.gen(function* () {
            if (!plan.armed) return;
            const already = yield* Ref.get(handedOff);
            const decision = decidePrewalkHandoff({
              armed: true,
              handedOff: already,
              tool,
              toolSucceeded: succeeded,
              exploreModel: plan.exploreModel,
              strongModel: plan.strongModel,
            });
            if (decision.kind !== "handoff") return;
            yield* Ref.set(handedOff, true);
            yield* Ref.set(activeModel, strongService);
            yield* emit({
              _tag: "topic",
              session,
              topic: PREWALK_HANDOFF_TOPIC,
              payload: {
                from: decision.from,
                to: decision.to,
                tool: decision.tool,
              },
            } as AgentEventPayload);
            yield* Effect.logInfo(
              `prewalk handoff ${decision.from} -> ${decision.to} after ${decision.tool}`,
            );
          }),
      });
      // Re-admit work that was recorded before the worker or client went away.
      // The store makes this retry idempotent; rows admitted with resume=false
      // stay available until an explicit prompt asks to schedule them.
      yield* store.pendingPrompts(session).pipe(
        Effect.flatMap((pending) =>
          Effect.forEach(
            pending.filter((entry) => entry.resume),
            (entry) => worker.resume(entry),
            { discard: true, concurrency: 1 },
          ),
        ),
      );
      yield* Stream.fromAsyncIterable(Bun.stdin.stream(), (error) => error).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.length > 0),
        Stream.mapEffect((line) =>
          S.decodeEffect(S.fromJsonString(AttachFrame))(line).pipe(
            Effect.mapError(
              (error) => new AgentWorkerError({ message: sanitizeAgentError(String(error)) }),
            ),
          ),
        ),
        Stream.runForEach((frame) =>
          Effect.suspend(() => {
            // `session.message` is the generic daemon primitive this harness's
            // own verbs (agent.prompt, agent.interrupt, agent.permission) ride
            // on. Every other frame tag — resize, input, sync, ping, and
            // whatever else the daemon sends any backend on this same stdin
            // channel — is administrative traffic no component worker acts on
            // and must be skipped rather than treated as a malformed command:
            // this is the process's one control loop, so failing it over a
            // frame that was never meant for it ends the whole session.
            if (frame._tag !== "session.message") return Effect.void;
            return Option.match(decodeNativeControl(frame.message), {
              onNone: () =>
                new AgentWorkerError({ message: "invalid native harness control message" }),
              onSome: (control: NativeControl) =>
                Match.value(control).pipe(
                  Match.tag("agent.prompt", (prompt) => {
                    const options = {
                      delivery: prompt.delivery ?? ("queue" as const),
                      resume: prompt.resume,
                      id: prompt.id,
                      replace: prompt.replace,
                    };
                    return worker.prompt(prompt.text, options);
                  }),
                  Match.tag("agent.interrupt", (interrupt) => worker.interrupt(interrupt.reason)),
                  Match.tag("agent.permission", (permission) =>
                    gate.resolve(permission.request, permission.decision, permission.feedback),
                  ),
                  Match.tag("agent.compact", (compact) =>
                    worker.compact({
                      instructions: compact.instructions,
                      force: true,
                    }).pipe(Effect.asVoid),
                  ),
                  Match.exhaustive,
                ),
            });
          }),
        ),
        Effect.catch((error) => emitError(sanitizeAgentError(String(error)))),
      );
      yield* worker.close;
    }).pipe(Effect.provide(Layer.mergeAll(modelLayer, projectStoreLayer(root))));
  });

  Effect.runPromise(
    Effect.scoped(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(IntegrationDefault, ModelCatalog.Default).pipe(
            Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, Path.layer)),
          ),
        ),
      ),
    ),
    // @effect-diagnostics-next-line asyncFunction:off -- the outermost process-boundary catch; nothing above it to run this Effect in.
  ).catch(async (error) => {
    await Effect.runPromise(emitError(sanitizeAgentError(String(error))));
    process.exitCode = 1;
  });
}
