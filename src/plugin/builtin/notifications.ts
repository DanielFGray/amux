import { Effect, Schema as S } from "effect";
import { ProcessState } from "../../process-state.ts";
import { POLL_MS } from "../../ui/state.ts";
import { scheduledPoll } from "../../effect/timer.ts";
import { definePlugin, type PluginDefinition } from "../types.ts";
import { CommandsTag, OptionsTag, registerCommand } from "../services.ts";

export const NOTIFICATIONS_PLUGIN_ID = "amux.notifications";

/**
 * The bell on a blocked agent, as a plugin — the reference implementation of
 * "subscribes to the arbitrated agent state and renders its own notification".
 * A replacement plugin reads the same `panel.display()` rows and reacts
 * however it likes; this one just rings the terminal.
 */
export const notificationsPlugin: PluginDefinition = definePlugin({
  id: NOTIFICATIONS_PLUGIN_ID,
  apiVersion: "1",
  inject: [OptionsTag, CommandsTag],
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = yield* OptionsTag;
      yield* options.register([
        "notifications.blocked",
        { kind: "boolean", default: true, desc: "ring the terminal when an agent becomes blocked" },
      ]);

      // `target: "server"` — no workspace state to mutate, so this is also the
      // proof of concept for a plugin verb reaching a client from `amux`'s CLI:
      // the daemon runs no plugins, so it forwards the tag to this client
      // verbatim and relays back whatever this handler returns.
      yield* registerCommand(
        "ring",
        { times: S.optional(S.Int) },
        { desc: "ring the terminal bell", group: "notifications", target: "server", exposure: "human" },
        (args) =>
          Effect.sync(() => {
            for (let i = 0; i < (args.times ?? 1); i++) process.stdout.write("\x07");
          }),
      );

      // Rows are the client's arbitrated view of agent state, the same one the
      // sidebar renders from — polled rather than pushed, since the plugin API
      // hands out no raw daemon event stream.
      let blocked = new Set<string>();
      yield* Effect.forkScoped(
        scheduledPoll(POLL_MS, () => {
          const next = new Set(
            ctx.panel
              .display()
              .rows.filter((row) => row.agentState === ProcessState.Blocked)
              .map((row) => row.agentId!),
          );
          if (ctx.panel.options()["notifications.blocked"]) {
            for (const id of next) if (!blocked.has(id)) process.stdout.write("\x07");
          }
          blocked = next;
        }),
      );
    }),
});

export default notificationsPlugin;
