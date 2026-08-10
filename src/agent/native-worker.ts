import { Chat, Tool, Toolkit } from "@effect/ai";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Schema as S, Stream } from "effect";
import { Default as IntegrationDefault, Service as Integration } from "../integration.ts";
import { loadConfig } from "../config.ts";
import { parseModelReference, resolveOptions } from "../options.ts";
import { controlCallPath } from "../control-client.ts";
import { COMMAND_DEFS, command } from "../commands.ts";
import { encodeAttachFrame, type AgentFrame, type AttachFrame } from "../effect/AttachProtocol.ts";
import { makeAgentWorker } from "./worker.ts";

// --- Native tool name mapping ---
// OpenAI and Anthropic reject dot-containing function names.
// Each COMMAND_DEFS tag has exactly one dot, so replacing it with an underscore
// is a bijection. The explicit bidirectional maps ensure deterministic lookup
// regardless of any existing underscores in command names (e.g. pane.send_keys).

const nativeToolName = (tag: string): string => tag.replace(/\./g, "_");

const buildNativeMapping = (defs: readonly { tag: string }[]) => {
  const safeToCommand = new Map<string, string>();
  const commandToSafe = new Map<string, string>();
  for (const def of defs) {
    const safe = nativeToolName(def.tag);
    safeToCommand.set(safe, def.tag);
    commandToSafe.set(def.tag, safe);
  }
  return { safeToCommand, commandToSafe };
};

export function nativeToolkit() {
  const agentDefs = COMMAND_DEFS.filter((def) => def.exposure === "agent");
  const mapping = buildNativeMapping(agentDefs);
  const tools = agentDefs.map((def) =>
    Tool.make(mapping.commandToSafe.get(def.tag)!, {
      description: def.desc,
      parameters: def.argumentFields,
      success: S.Unknown,
    }),
  );
  return Toolkit.make(...tools);
}

export { buildNativeMapping, nativeToolName };

// --- Process entry point ---

const session = process.env.AMUX_SESSION ?? process.env.AMUX_AGENT_ID;
const controlSocket = process.env.AMUX_CONTROL_SOCKET;

if (!import.meta.main) {
  // Imported as a module — exports only, don't validate env or start the daemon.
} else if (!session)
  throw new Error("AMUX_SESSION is required");
else if (!controlSocket)
  throw new Error("AMUX_CONTROL_SOCKET is required");
else {
const agentSize = JSON.parse(process.env.AMUX_AGENT_SIZE ?? '{"cols":80,"rows":24}') as {
  cols: number;
  rows: number;
};
const emit = (frame: AgentFrame) =>
  Effect.sync(() => process.stdout.write(encodeAttachFrame(frame)));

const program = Effect.gen(function* () {
  const modelReference = resolveOptions((yield* Effect.promise(() => loadConfig())).options)["agent.model"];
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
  yield* Effect.gen(function* () {
  const agentDefs = COMMAND_DEFS.filter((def) => def.exposure === "agent");
  const { safeToCommand, commandToSafe } = buildNativeMapping(agentDefs);
  const resolveCommand = (name: string): string => safeToCommand.get(name) ?? name;
  const executeTool = (tool: string, input: unknown) => {
    const tag = resolveCommand(tool);
    const value = command(tag as never, input as never);
    return controlCallPath(controlSocket, (control) =>
      control.Run({
        value: value as never,
        context: {
          size: agentSize,
          shell: [process.env.SHELL ?? "sh"],
          cwd: process.env.AMUX_AGENT_CWD ?? process.cwd(),
          agent: session,
        },
      }).pipe(Effect.map((result) => result.result)),
    );
  };
  const definitions = agentDefs.map((def) =>
    Tool.make(commandToSafe.get(def.tag)!, {
      description: def.desc,
      parameters: def.argumentFields,
      success: S.Unknown,
    }),
  );
  const toolkit = Toolkit.make(...definitions);
  // `toolkit.of` is only a type-level helper; the handlers have to be supplied
  // as a layer, and the Toolkit itself is the effect that yields them.
  const handlers = toolkit.of(
    Object.fromEntries(
      definitions.map((definition) => [
        definition.name,
        (input: unknown) => executeTool(definition.name, input),
      ]),
    ) as never,
  );
  const resolvedToolkit = toolkit.pipe(Effect.provide(toolkit.toLayer(handlers)));
  // Chat owns the conversation: history, tool-call/result pairing and the
  // provider message shape are all its job, not ours.
  const chat = yield* Chat.empty;
  const worker = yield* makeAgentWorker({
    session,
    chat,
    emit,
    toolkit: resolvedToolkit,
    toolName: resolveCommand,
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
          : Effect.void,
    ),
    Effect.orDie,
  );
    yield* worker.close;
  }).pipe(Effect.provide(modelLayer));
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
