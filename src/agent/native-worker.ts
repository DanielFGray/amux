import { LanguageModel, Tool, Toolkit } from "@effect/ai";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Runtime, Schema as S, Stream } from "effect";
import { Default as IntegrationDefault, Service as Integration } from "../integration.ts";
import { loadConfig } from "../config.ts";
import { parseModelReference, resolveOptions } from "../options.ts";
import { controlCallPath } from "../control-client.ts";
import { COMMAND_DEFS, command } from "../commands.ts";
import { encodeAttachFrame, type AgentFrame, type AttachFrame } from "../effect/AttachProtocol.ts";
import { makeAgentWorker, type AgentModelPart } from "./worker.ts";

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
    const languageModel = yield* LanguageModel.LanguageModel;
  const runtime = yield* Effect.runtime<never>();
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
  const handlers = toolkit.of(
    Object.fromEntries(
      definitions.map((definition) => [
        definition.name,
        (input: unknown) => executeTool(definition.name, input),
      ]),
    ) as never,
  );
  const model = (input: { readonly prompt: string; readonly signal: AbortSignal }) =>
    languageModel
      .streamText({
        prompt: input.prompt,
        toolkit: Effect.succeed(toolkit.of(handlers)),
        disableToolCallResolution: true,
      })
       .pipe(
        Stream.map((part): AgentModelPart | undefined => {
          const value = part as any;
          if (value.type === "text-delta") return { _tag: "text", text: value.delta };
          if (value.type === "tool-params-start")
            return { _tag: "tool.params-start", call: value.id, tool: resolveCommand(value.name) };
          if (value.type === "tool-params-delta")
            return { _tag: "tool.params-delta", call: value.id, delta: value.delta };
          if (value.type === "tool-params-end")
            return { _tag: "tool.params-end", call: value.id };
          if (value.type === "tool-call")
            return { _tag: "tool", call: value.id, tool: resolveCommand(value.name), input: value.params };
          if (value.type === "tool-result")
            return {
              _tag: "result",
              call: value.id,
              output: value.result,
              isError: value.isFailure,
            };
          return undefined;
        }),
         Stream.filter((part): part is AgentModelPart => part !== undefined),
      );
  const worker = yield* makeAgentWorker({ session, model, executeTool, emit });
  yield* Effect.promise(async () => {
    let buffer = new Uint8Array();
    for await (const chunk of Bun.stdin.stream()) {
      const bytes = new Uint8Array(buffer.length + chunk.length);
      bytes.set(buffer);
      bytes.set(chunk, buffer.length);
      let start = 0;
      for (let index = 0; index < bytes.length; index++) {
        if (bytes[index] !== 10) continue;
        const line = new TextDecoder().decode(bytes.subarray(start, index));
        start = index + 1;
        if (!line) continue;
        const frame = JSON.parse(line) as AttachFrame;
        if (frame._tag === "agent.steer")
          await Runtime.runPromise(runtime)(worker.steer(frame.message));
        if (frame._tag === "agent.interrupt")
          await Runtime.runPromise(runtime)(worker.interrupt(frame.reason));
      }
      buffer = bytes.slice(start);
    }
  });
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
