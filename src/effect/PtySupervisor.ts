import { Effect, FiberMap, Layer, Match, Ref, Scope, Stream } from "effect";
import { AttachHub } from "./AttachHub.ts";
import { type AttachFrame } from "./AttachProtocol.ts";
import { PtyError, PtyRegistry, type ManagedPty, type PtySpec } from "./PtyRegistry.ts";

/**
 * Connects daemon-owned PTYs to the attach data plane.
 *
 * A single FiberMap entry supervises each agent's output and exit publication.
 * The PTY itself remains scoped by PtyRegistry, outside any client scope, so a
 * UI disconnect cannot kill the agent.
 */
export class PtySupervisor extends Effect.Service<PtySupervisor>()("PtySupervisor", {
  // scoped for the same reason as PtyRegistry: the per-agent output pumps are a
  // FiberMap, and they belong to the supervisor rather than to any caller.
  scoped: Effect.gen(function* () {
    const registry = yield* PtyRegistry;
    const hub = yield* AttachHub;
    const pumps = yield* FiberMap.make<string>();
    const agents = yield* Ref.make<ReadonlyMap<string, ManagedPty>>(new Map());

    return {
      spawn: Effect.fnUntraced(function* (spec: PtySpec) {
        const pty = yield* registry.spawn(spec);
        yield* Ref.update(agents, (current) => new Map(current).set(spec.id, pty));
        yield* FiberMap.run(
          pumps,
          spec.id,
          Effect.gen(function* () {
            yield* pty.output.pipe(
              Stream.runForEach((chunk) =>
                hub.publish({
                  _tag: "output",
                  agent: spec.id,
                  // readPty reuses its backing buffer, so queued frames need
                  // ownership of their bytes before the next read.
                  data: new Uint8Array(chunk),
                } satisfies AttachFrame),
              ),
              // A read that fails is the end of this agent's output, not the
              // end of the agent as far as clients are concerned: they still
              // need the exit frame below to stop showing it as running.
              Effect.catchAll((error) =>
                Effect.logDebug(`pty output ended: ${error.operation}: ${error.message}`),
              ),
            );

            // Published only once the output stream is exhausted, never
            // alongside it. The process exits before its last bytes have been
            // read — that is what the drain in readPty is for — so a forked
            // exit publication overtakes them, and a client that trusts frame
            // order would blank the pane and then receive output for an agent
            // it had already buried.
            const code = yield* pty.exit.pipe(Effect.orElseSucceed(() => null));
            yield* hub.publish({ _tag: "exit", agent: spec.id, code } satisfies AttachFrame);
            yield* Ref.update(agents, (current) => {
              const next = new Map(current);
              next.delete(spec.id);
              return next;
            });
          }),
        );
        return pty;
      }),

      handle: Effect.fnUntraced(function* (frame: AttachFrame) {
        yield* Match.value(frame).pipe(
          Match.tag("input", "resize", (command) =>
            Effect.gen(function* () {
              const pty = (yield* Ref.get(agents)).get(command.agent);
              if (!pty) {
                return yield* new PtyError({
                  operation: command._tag,
                  message: `unknown agent '${command.agent}'`,
                });
              }
              yield* Match.value(command).pipe(
                Match.tag("input", (input) => pty.write(input.data)),
                Match.tag("resize", (resize) => pty.resize(resize.cols, resize.rows)),
                Match.exhaustive,
              );
            })),
          Match.orElse(() => Effect.void),
        );
      }),

      live: Ref.get(agents).pipe(Effect.map((current) => [...current.keys()])),

      kill: Effect.fnUntraced(function* (id: string) {
        const pty = (yield* Ref.get(agents)).get(id);
        if (!pty)
          return yield* new PtyError({ operation: "kill", message: `unknown agent '${id}'` });
        yield* pty.kill;
      }),
    };
  }),
}) {
  static Live = PtySupervisor.Default.pipe(Layer.provide(PtyRegistry.Default));
}
