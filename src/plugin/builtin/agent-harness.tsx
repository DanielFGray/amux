/** @jsxImportSource @opentui/solid */
import { Effect, Layer, Redacted } from "effect";
import { For, createSignal } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { BunFileSystem } from "@effect/platform-bun";
import { command } from "../../commands.ts";
import { Default as IntegrationDefault, integrations } from "../../integration.ts";
import { Default as ModelCatalogDefault } from "../../model-catalog.ts";
import { definePlugin, type PluginDefinition } from "../types.ts";
import {
  BindingsTag,
  RegionsTag,
  SessionViewsTag,
  SettingsTag,
  SpawnProvidersTag,
} from "../services.ts";
import { Chat } from "./agent-harness/Chat.tsx";
import { registerModelPicker } from "./agent-harness/ModelPicker.tsx";
import { agentPreflight } from "./agent-harness/preflight.ts";
import { theme } from "../../ui/theme.ts";
import { Service as Integration, type Info as IntegrationInfo } from "../../integration.ts";
import { Credential } from "../../credential.ts";

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
 * harness's own choice about crash isolation and not a contract. Its provider
 * registration supplies launch details only when a pending session resumes.
 */
export const agentHarnessPlugin: PluginDefinition = definePlugin({
  id: AGENT_HARNESS_PLUGIN_ID,
  apiVersion: "1",
  inject: [BindingsTag, RegionsTag, SessionViewsTag, SettingsTag, SpawnProvidersTag],
  effect: (ctx) =>
    Effect.gen(function* () {
      const bindings = yield* BindingsTag;
      const sessionViews = yield* SessionViewsTag;
      const settings = yield* SettingsTag;
      const spawnProviders = yield* SpawnProvidersTag;
      const openModelPicker = (yield* registerModelPicker(ctx)).pipe(Effect.provide(llmServices));
      const [providers, setProviders] = createSignal<readonly IntegrationInfo[]>([]);
      const [selected, setSelected] = createSignal(0);
      const refreshProviders = Effect.gen(function* () {
        const integrations = yield* Integration;
        setProviders(yield* integrations.list());
      }).pipe(Effect.provide(llmServices));
      Effect.runFork(refreshProviders);
      yield* settings.register({
        id: "auth",
        label: "auth",
        rows: () => providers().length,
        keys: (event: KeyEvent) => {
          if (event.name === "j" || event.name === "down")
            setSelected((value) => Math.min(providers().length - 1, value + 1));
          if (event.name === "k" || event.name === "up")
            setSelected((value) => Math.max(0, value - 1));
          if (event.name === "d") {
            const connection = providers()[selected()]?.connections[0];
            if (connection)
              Effect.runFork(
                yieldCredential().pipe(
                  Effect.flatMap((credentials) => credentials.remove(connection.id)),
                  Effect.provide(Credential.Default),
                  Effect.provide(BunFileSystem.layer),
                  Effect.tap(() => refreshProviders),
                ),
              );
          }
        },
        component: (props) => (
          <AuthSettings
            providers={providers()}
            selected={props.selected}
            onSubmit={(key) => connect(providers()[props.selected], key)}
          />
        ),
      });

      // A binding's effect is built once, so the option has to be read inside
      // it: `agent.model` is settings the user changes while amux runs, and a
      // value captured here would be whichever model was configured at startup.
      const start = Effect.suspend(() =>
        agentPreflight(ctx.panel.options()["agent.model"] as string),
      ).pipe(
        Effect.flatMap(() =>
          ctx.panel.run({
            _tag: "agent.new",
            provider: "native",
          }),
        ),
        Effect.asVoid,
        Effect.provide(llmServices),
      );

      yield* spawnProviders.register([
        "native",
        () => ({
          argv: [
            process.execPath,
            new URL("./agent-harness/native-worker.ts", import.meta.url).pathname,
          ],
          // A provider key exported into the daemon's environment must not reach
          // the worker's environ, where any process could read it via /proc. The
          // harness knows which variables its integrations treat as credentials.
          stripEnv: [...new Set(integrations.flatMap((integration) => integration.env))],
        }),
      ]);

      yield* bindings.register({
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
      yield* bindings.register({
        name: "agent.model",
        desc: "choose the model the native agent uses",
        group: "agents",
        run: openModelPicker,
      });

      const run = (value: Parameters<typeof ctx.panel.run>[0]) =>
        Effect.runFork(
          ctx.panel
            .run(value)
            .pipe(
              Effect.catchAll((error) => Effect.sync(() => ctx.panel.reportError(error.message))),
            ),
        );

      yield* sessionViews.register([
        "native",
        (props) => (
          <Chat
            {...props}
            model={ctx.panel.options()["agent.model"] as string}
            showThinking={ctx.panel.options()["agent.showThinking"] as boolean}
            onSlashCommand={(command) => {
              if (command !== "/model") return false;
              Effect.runFork(openModelPicker);
              return true;
            }}
            slashCommands={[{ name: "model", description: "choose the agent model" }]}
            frames={ctx.frames}
            sync={ctx.sync}
            onSubmit={(message) =>
              run(
                command("agent.prompt", {
                  target: props.sessionId,
                  text: message,
                }),
              )
            }
            onPermission={(request, decision, feedback) =>
              run(
                command("agent.permission", {
                  session: props.sessionId,
                  request,
                  decision,
                  ...(feedback ? { feedback } : {}),
                }),
              )
            }
            onInterrupt={() => run(command("agent.interrupt", { session: props.sessionId }))}
          />
        ),
      ]);

      function yieldCredential() {
        return Credential.Service;
      }
      const connect = (provider: IntegrationInfo | undefined, key: string) => {
        if (!provider || !key) return;
        Effect.runFork(
          yieldCredential().pipe(
            Effect.flatMap((credentials) =>
              provider.connections[0]
                ? credentials.update(provider.connections[0].id, {
                    value: { type: "key", key: Redacted.make(key) },
                  })
                : credentials
                    .create({
                      integrationID: provider.id,
                      value: { type: "key", key: Redacted.make(key) },
                    })
                    .pipe(Effect.asVoid),
            ),
            Effect.provide(Credential.Default),
            Effect.provide(BunFileSystem.layer),
            Effect.tap(() => refreshProviders),
          ),
        );
      };
    }),
});

/** Loaded from its own source like any other plugin, and so exported like one. */
export default agentHarnessPlugin;

/** The catalog is behind the integration registry as well, but only the registry
 *  can see it there — the preflight asks the catalog directly, so both are
 *  built here over one filesystem. */
const llmServices = Layer.mergeAll(IntegrationDefault, ModelCatalogDefault).pipe(
  Layer.provide(BunFileSystem.layer),
);

function AuthSettings(props: {
  readonly providers: readonly IntegrationInfo[];
  readonly selected: number;
  readonly onSubmit: (key: string) => void;
}) {
  const [key, setKey] = createSignal("");
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <For each={props.providers}>
        {(provider, index) => (
          <box
            style={{
              flexDirection: "row",
              height: 1,
              backgroundColor: index() === props.selected ? theme.surface1 : theme.base,
            }}
          >
            <text style={{ fg: theme.text, width: 18 }}>{provider.label}</text>
            <text
              style={{
                fg: provider.connections.length ? theme.green : theme.overlay1,
              }}
            >
              {provider.connections.length
                ? provider.connections.map((connection) => connection.label).join(", ")
                : "not connected"}
            </text>
          </box>
        )}
      </For>
      <input
        placeholder="API key, then enter"
        value={key()}
        onInput={(value: string) => setKey(value)}
        onSubmit={() => props.onSubmit(key())}
      />
    </box>
  );
}
