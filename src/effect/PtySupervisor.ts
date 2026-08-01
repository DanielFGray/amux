import { Effect, Fiber, FiberMap, Layer, Ref, Stream } from "effect"
import { AttachHub } from "./AttachHub.ts"
import { type AttachFrame } from "./AttachProtocol.ts"
import { PtyError, PtyRegistry, type ManagedPty, type PtySpec } from "./PtyRegistry.ts"

/**
 * Connects daemon-owned PTYs to the attach data plane.
 *
 * A single FiberMap entry supervises each agent's output and exit publication.
 * The PTY itself remains scoped by PtyRegistry, outside any client scope, so a
 * UI disconnect cannot kill the agent.
 */
export class PtySupervisor extends Effect.Service<PtySupervisor>()("PtySupervisor", {
  effect: Effect.gen(function* () {
    const registry = yield* PtyRegistry
    const hub = yield* AttachHub
    const pumps = yield* FiberMap.make<string>()
    const agents = yield* Ref.make<ReadonlyMap<string, ManagedPty>>(new Map())

    const spawn = (spec: PtySpec): Effect.Effect<ManagedPty, PtyError, import("effect/Scope").Scope> =>
      Effect.gen(function* () {
        const pty = yield* registry.spawn(spec)
        yield* Ref.update(agents, (current) => new Map(current).set(spec.id, pty))
        yield* FiberMap.run(
          pumps,
          spec.id,
          Effect.gen(function* () {
            const exitFiber = yield* Effect.forkScoped(
              pty.exit.pipe(
                Effect.flatMap((code) =>
                  hub.publish({ _tag: "exit", agent: spec.id, code } satisfies AttachFrame),
                ),
              ),
            )
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
            )
            yield* Fiber.join(exitFiber)
            yield* Ref.update(agents, (current) => {
              const next = new Map(current)
              next.delete(spec.id)
              return next
            })
          }),
        )
        return pty
      })

    const handle = (frame: AttachFrame): Effect.Effect<void, PtyError> =>
      Effect.gen(function* () {
        if (frame._tag !== "input" && frame._tag !== "resize") return
        const pty = (yield* Ref.get(agents)).get(frame.agent)
        if (!pty) {
          return yield* Effect.fail(new PtyError({ operation: frame._tag, message: `unknown agent '${frame.agent}'` }))
        }
        if (frame._tag === "input") yield* pty.write(frame.data)
        else yield* pty.resize(frame.cols, frame.rows)
      })

    return { spawn, handle }
  }),
}) {}

export const PtySupervisorLive = PtySupervisor.Default.pipe(Layer.provide(PtyRegistry.Default))
