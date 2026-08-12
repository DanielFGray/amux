/** @jsxImportSource @opentui/solid */
import { Effect, Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { command } from "../../commands.ts";
import { Default as IntegrationDefault } from "../../integration.ts";
import { Default as ModelCatalogDefault } from "../../model-catalog.ts";
import type { PluginDefinition } from "../types.ts";
import { Chat } from "./agent-harness/Chat.tsx";
import { registerModelPicker } from "./agent-harness/ModelPicker.tsx";
import { agentPreflight } from "./agent-harness/preflight.ts";

export const AGENT_HARNESS_PLUGIN_ID = "amux.agent-harness";

/**
 * The harness we ship, as a plugin — the acceptance test for the plugin API.
 *
 * Everything an LLM needs is acquired here and nowhere else: the credential
 * registry, the model catalog and the turn loop all hang off this scope, so
 * disabling the plugin takes them with it. Core hands the plugin no provider,
 * no model and no credential; if it ever has to, the API is unfinished and the
 * fix belongs in the API.
 *
 * The turn loop runs in a worker child rather than in the client, which is this
 * harness's own choice about crash isolation and not a contract: `agent.new`
 * carries the command to spawn, so another harness names its own entry point —
 * or none, and runs its loop inline.
 */
export const agentHarnessPlugin: PluginDefinition = {
  id: AGENT_HARNESS_PLUGIN_ID,
  apiVersion: "1",
  effect: (ctx) =>
    Effect.sync(() => {
      const openModelPicker = registerModelPicker(ctx).pipe(Effect.provide(llmServices));

      // A binding's effect is built once, so the option has to be read inside
      // it: `agent.model` is settings the user changes while amux runs, and a
      // value captured here would be whichever model was configured at startup.
      const start = Effect.suspend(() =>
        agentPreflight(ctx.panel.options()["agent.model"] as string),
      ).pipe(
        Effect.flatMap(() =>
          ctx.panel.run({
            _tag: "agent.new",
            harness: "native",
            cmd: [
              process.execPath,
              new URL("./agent-harness/native-worker.ts", import.meta.url).pathname,
            ],
          }),
        ),
        Effect.asVoid,
        Effect.provide(llmServices),
      );

      ctx.registerBinding({
        name: "agent.new",
        key: "<leader>shift+n",
        desc: "open a chat pane with a new native agent",
        group: "agents",
        run: start,
      });

      // Named after the option it edits. An option whose value is a list to
      // search cannot be edited with ←/→, so the settings window hands the row
      // to the command of the same name — the harness's own, since core has no
      // idea what models a provider has.
      ctx.registerBinding({
        name: "agent.model",
        desc: "choose the model the native agent uses",
        group: "agents",
        run: openModelPicker,
      });

      ctx.registerPaneType("native", (props) => (
        <Chat
          {...props}
          model={ctx.panel.options()["agent.model"] as string}
          onSlashCommand={(command) => {
            if (command !== "/model") return false;
            Effect.runFork(openModelPicker);
            return true;
          }}
          slashCommands={[{ name: "model", description: "choose the agent model" }]}
          frames={ctx.frames}
          sync={ctx.sync}
          onSubmit={(message) => {
            Effect.runFork(
              ctx.panel
                .run(command("agent.steer", { session: props.sessionId, message }))
                .pipe(
                  Effect.catchAll((error) =>
                    Effect.sync(() => ctx.panel.reportError(error.message)),
                  ),
                ),
            );
          }}
        />
      ));
    }),
};

/** The catalog is behind the integration registry as well, but only the registry
 *  can see it there — the preflight asks the catalog directly, so both are
 *  built here over one filesystem. */
const llmServices = Layer.mergeAll(IntegrationDefault, ModelCatalogDefault).pipe(
  Layer.provide(BunFileSystem.layer),
);
