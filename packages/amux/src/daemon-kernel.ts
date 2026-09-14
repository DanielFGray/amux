import { Context, Effect, Exit, Layer, Scope } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import {
  AttachHost,
  type AttachHostOptions,
  type AttachHostService,
  layerAttachServer,
  layerSessionSupervisor,
} from "./effect/AttachHost.ts";
import type { AgentLogService } from "./effect/AgentLog.ts";
import { AttachHub } from "./effect/AttachHub.ts";
import { SessionSupervisor } from "./effect/SessionSupervisor.ts";
import { createPluginHost, type PluginHost } from "./plugin/host.ts";
import type { PluginContributions } from "./plugin/contributions.ts";
import { definePlugin, type PluginDefinition } from "./plugin/types.ts";

export interface DaemonKernelPhase {
  readonly attachHost: AttachHostService;
  readonly pluginHost: PluginHost;
  readonly close: Effect.Effect<void>;
}

export interface StartDaemonKernel {
  readonly scope: Scope.Scope;
  readonly contributions: PluginContributions;
  readonly attach: AttachHostOptions;
  readonly agentLog: AgentLogService;
}

const kernelEntries = (input: StartDaemonKernel): readonly PluginDefinition[] => [
  {
    id: "amux.kernel.attach-hub",
    provide: [AttachHub],
    activate: (ctx) =>
      Layer.build(AttachHub.layer).pipe(
        Effect.tap((services) =>
          Effect.sync(() => void ctx.provide(AttachHub, Context.get(services, AttachHub))),
        ),
        Effect.orDie,
      ),
  },
  definePlugin({
    id: "amux.kernel.session-supervisor",
    inject: [AttachHub],
    provide: [SessionSupervisor],
    effect: (ctx) =>
      Layer.build(
        layerSessionSupervisor({
          agentLog: input.agentLog,
          onSessionExit: input.attach.onSessionExit,
          onSessionState: input.attach.onSessionState,
        }),
      ).pipe(
        Effect.tap((services) =>
          Effect.sync(
            () => void ctx.provide(SessionSupervisor, Context.get(services, SessionSupervisor)),
          ),
        ),
        Effect.orDie,
      ),
  }),
  definePlugin({
    id: "amux.kernel.attach-host",
    inject: [AttachHub, SessionSupervisor],
    provide: [AttachHost],
    effect: (ctx) =>
      Layer.build(layerAttachServer(input.attach).pipe(Layer.provide(BunFileSystem.layer))).pipe(
        Effect.tap((services) =>
          Effect.sync(() => void ctx.provide(AttachHost, Context.get(services, AttachHost))),
        ),
        Effect.orDie,
      ),
  }),
];

/** Start the attach kernel only — user `./daemon` plugins load in the plugin-host. */
export const startDaemonKernel = Effect.fnUntraced(function* (input: StartDaemonKernel) {
  const phaseScope = yield* Scope.fork(input.scope, "sequential");
  const host = yield* createPluginHost({ contributions: input.contributions }).pipe(
    Effect.provideService(Scope.Scope, phaseScope),
  );
  const phase = yield* host.reconcile([...kernelEntries(input)]).pipe(
    Effect.andThen(host.await(AttachHost)),
    Effect.map((attachHost) => ({
      attachHost,
      pluginHost: host,
      close: Scope.close(phaseScope, Exit.void),
    })),
    Effect.onError(() => Scope.close(phaseScope, Exit.void)),
  );
  return phase;
});
