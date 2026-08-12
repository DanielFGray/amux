import { Chat } from "@effect/ai";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Stream } from "effect";
import { Default as IntegrationDefault, Service as Integration } from "../../../integration.ts";
import { loadConfig } from "../../../config.ts";
import { parseModelReference, resolveOptions } from "../../../options.ts";
import {
  encodeAttachFrame,
  type AgentEventPayload,
  type AgentDelta,
  type AttachFrame,
} from "../../../effect/AttachProtocol.ts";
import { agentToolkit } from "./tools.ts";
import { makePermissionGate } from "./permission.ts";
import { DEFAULT_RULES } from "../../../permission.ts";
import { projectRoot } from "../../../git.ts";
import { layer as projectStoreLayer, Service as ProjectStore } from "../../../project-store.ts";
import { makeAgentWorker } from "./worker.ts";

// --- Process entry point ---

const session = process.env.AMUX_SESSION ?? process.env.AMUX_AGENT_ID;

if (!import.meta.main) {
  // Imported as a module — exports only, don't validate env or start the daemon.
} else if (!session) throw new Error("AMUX_SESSION is required");
else {
  // The turn a permission request belongs to is on the wire already: every
  // request is raised by a tool inside the turn whose start frame went out last.
  let turn = "";
  const emit = (frame: AgentEventPayload | AgentDelta) =>
    Effect.sync(() => {
      if (frame._tag === "turn.start") turn = frame.turn;
      return process.stdout.write(
        encodeAttachFrame(
          frame._tag === "text.delta" || frame._tag.startsWith("tool.params-")
            ? (frame as AttachFrame)
            : ({ _tag: "agent.event", event: frame } as AttachFrame),
        ),
      );
    });

  const workspace = process.env.AMUX_AGENT_CWD ?? process.cwd();

  const program = Effect.gen(function* () {
    const config = yield* Effect.promise(() => loadConfig());
    const modelReference = resolveOptions(config.options)["agent.model"];
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
      const chat = yield* Chat.empty;
      const worker = yield* makeAgentWorker({
        session,
        chat,
        emit,
        toolkit,
      });
      yield* Stream.fromAsyncIterable(Bun.stdin.stream(), (error) => error).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.length > 0),
        Stream.map((line) => JSON.parse(line) as AttachFrame),
        Stream.runForEach((frame) =>
          frame._tag === "agent.steer"
            ? worker.steer(frame.message)
            : frame._tag === "agent.interrupt"
              ? worker.interrupt(frame.reason)
              : frame._tag === "agent.permission"
                ? gate.resolve(frame.request, frame.decision, frame.feedback)
                : Effect.void,
        ),
        Effect.orDie,
      );
      yield* worker.close;
    }).pipe(Effect.provide(modelLayer), Effect.provide(projectStoreLayer(root)));
  });

  Effect.runPromise(
    Effect.scoped(
      program.pipe(Effect.provide(IntegrationDefault), Effect.provide(BunFileSystem.layer)),
    ) as Effect.Effect<void, unknown, never>,
  ).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
