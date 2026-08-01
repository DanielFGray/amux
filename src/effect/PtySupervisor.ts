import { Effect, FiberMap, Layer, Match, Ref, Scope, Stream } from "effect";
import { Terminal } from "../ghostty.ts";
import { formatScreen } from "../shim.ts";
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
    const agents = yield* Ref.make<ReadonlyMap<string, ManagedPty>>(new Map());
    // The daemon-side screen model per agent. A reattaching client has none of
    // an adopted agent's history, so its pane would be blank until the program
    // next redraws; this terminal is what lets the daemon answer an adoption
    // with the agent's current screen. scrollback 0: only the active screen is
    // ever needed, and an emulator per agent is cost enough without history.
    const replays = yield* Ref.make<ReadonlyMap<string, Terminal>>(new Map());
    yield* Effect.addFinalizer(() =>
      Ref.get(replays).pipe(
        Effect.flatMap((screens) =>
          Effect.sync(() => {
            for (const screen of screens.values()) screen.free();
          }),
        ),
      ),
    );
    // Register the screen finalizer before the pump map so scope teardown
    // interrupts pumps before freeing the terminals they may still touch.
    const pumps = yield* FiberMap.make<string>();

    const dropScreen = (id: string) =>
      Effect.gen(function* () {
        const screen = (yield* Ref.get(replays)).get(id);
        if (!screen) return;
        screen.free();
        yield* Ref.update(replays, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      });

    return {
      spawn: Effect.fnUntraced(function* (spec: PtySpec) {
        const pty = yield* registry.spawn(spec);
        // Sized before the pump runs: the first chunk the PTY produces is fed
        // to both the hub and the screen model, so the model must exist first.
        const screen = new Terminal(spec.cols, spec.rows, 0);
        yield* Ref.update(replays, (current) => new Map(current).set(spec.id, screen));
        yield* Ref.update(agents, (current) => new Map(current).set(spec.id, pty));
        yield* FiberMap.run(
          pumps,
          spec.id,
          Effect.gen(function* () {
            yield* pty.output.pipe(
              Stream.runForEach((chunk) =>
                Effect.gen(function* () {
                  // readPty reuses its backing buffer, so the screen model must
                  // take its bytes before the frame's copy does: the write is
                  // synchronous, then the copy is owned by the queued frame.
                  screen.write(chunk);
                  yield* hub.publish({
                    _tag: "output",
                    agent: spec.id,
                    data: new Uint8Array(chunk),
                  } satisfies AttachFrame);
                }),
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
            // A dead agent cannot be adopted, so its screen model is done too.
            yield* dropScreen(spec.id);
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
              if (command._tag === "resize") {
                // Size the screen model before the PTY: the child redraws in
                // response to SIGWINCH, and the redraw must land on a model
                // that is already the right size. The model resize is
                // synchronous; the PTY resize goes through the pty's command
                // pump, so the ordering is safe by construction.
                (yield* Ref.get(replays)).get(command.agent)?.resize(command.cols, command.rows);
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

      /** Replay an adopted agent's screen to the client that asked for it. */
      sync: Effect.fnUntraced(function* (client: string, id: string) {
        const screen = (yield* Ref.get(replays)).get(id);
        if (!screen) return;
        const data = yield* Effect.sync(() => formatScreen(screen.handle));
        if (data.length === 0) return;
        yield* hub.publishTo(client, { _tag: "output", agent: id, data } satisfies AttachFrame);
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
