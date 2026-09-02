import { Chat } from "effect/unstable/ai";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Match, Option, Schema as S, Stream } from "effect";
import { Default as IntegrationDefault, Service as Integration } from "./integration.ts";
import { loadConfig } from "@danielfgray/amux/config.ts";
import { coerceOption } from "@danielfgray/amux";
import { AGENT_HARNESS_OPTIONS, parseModelReference } from "./options.ts";
import {
  AttachFrame,
  encodeAttachFrame,
  type AgentDelta,
  type AgentEventPayload,
} from "@danielfgray/amux/protocol";
import { emit as toAgentMessage, type HarnessEvent } from "./protocol.ts";
import { agentToolkit } from "./tools.ts";
import { makePermissionGate } from "./permission.ts";
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
  }),
  S.TaggedStruct("agent.interrupt", { reason: S.optional(S.String) }),
  S.TaggedStruct("agent.permission", {
    request: S.String,
    decision: PermissionDecisionSchema,
    feedback: S.optional(S.String),
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
    const { providerID, modelID: modelName } = model;
    const modelLayer = yield* Integration.pipe(
      Effect.flatMap((integration) => integration.model(providerID, modelName)),
      Effect.flatMap((layer) =>
        layer ? Effect.succeed(layer) : Effect.fail(`credential missing for ${providerID}`),
      ),
    );
    // Approvals belong to the repository, not to this worktree or this pane, so
    // the store is opened on the project root that every worktree shares.
    const root = yield* Effect.promise(() => projectRoot(workspace));
    yield* Effect.gen(function* () {
      const store = yield* ProjectStore;
      const gate = yield* makePermissionGate({
        session,
        turn: Effect.sync(() => turn),
        // Defaults, then the config file, then what the user approved here: the
        // order is the precedence, and `evaluate` reads it as last-match-wins.
        rules: [...DEFAULT_RULES, ...config.permissions, ...(yield* store.rules)],
        store,
        emit,
      });
      const toolkit = agentToolkit(workspace, gate);
      // Chat owns the conversation: history, tool-call/result pairing and the
      // provider message shape are all its job, not ours.
      const savedConversation = yield* store.conversation(session);
      const chat =
        savedConversation === undefined
          ? yield* Chat.empty
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
        persist: chat.exportJson.pipe(
          Effect.flatMap((conversation) => store.saveConversation(session, conversation)),
          Effect.ignore,
        ),
        onTurnStart: (turnId) =>
          Effect.sync(() => {
            turn = turnId;
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
            // `session.message` is the generic daemon primitive. This
            // worker's payload vocabulary remains private to the harness.
            const payload = Match.value(frame).pipe(
              Match.tag("session.message", (message) => message.message),
              Match.orElse((other) => other),
            );
            return Option.match(decodeNativeControl(payload), {
              onNone: () =>
                new AgentWorkerError({ message: "invalid native harness control message" }),
              onSome: (control: NativeControl) =>
                Match.value(control).pipe(
                  Match.tag("agent.prompt", (prompt) =>
                    worker.prompt(
                      prompt.text,
                      prompt.id === undefined
                        ? { delivery: prompt.delivery ?? "queue", resume: prompt.resume }
                        : {
                            id: prompt.id,
                            delivery: prompt.delivery ?? "queue",
                            resume: prompt.resume,
                          },
                    ),
                  ),
                  Match.tag("agent.interrupt", (interrupt) => worker.interrupt(interrupt.reason)),
                  Match.tag("agent.permission", (permission) =>
                    gate.resolve(permission.request, permission.decision, permission.feedback),
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
        Effect.provide(IntegrationDefault.pipe(Layer.provideMerge(BunFileSystem.layer))),
      ),
    ),
    // @effect-diagnostics-next-line asyncFunction:off -- the outermost process-boundary catch; nothing above it to run this Effect in.
  ).catch(async (error) => {
    await Effect.runPromise(emitError(sanitizeAgentError(String(error))));
    process.exitCode = 1;
  });
}
