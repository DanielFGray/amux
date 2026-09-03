/** @jsxImportSource @opentui/solid */
import { Effect, Layer, Redacted } from "effect";
import { For, createSignal } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { BunFileSystem } from "@effect/platform-bun";
import { command, runtimeCommand } from "@danielfgray/amux";
import { Default as IntegrationDefault, integrations } from "./integration.ts";
import { Default as ModelCatalogDefault } from "./model-catalog.ts";
import { definePlugin, type PluginDefinition } from "@danielfgray/amux";
import {
  BindingsTag,
  OptionsTag,
  PanelTag,
  RegionsTag,
  SessionStreamTag,
  SessionViewsTag,
  SettingsTag,
  SpawnProvidersTag,
} from "@danielfgray/amux";
import { Chat } from "./Chat.tsx";
import { registerModelPicker } from "./ModelPicker.tsx";
import { agentPreflight } from "./preflight.ts";
import { AGENT_HARNESS_OPTIONS } from "./options.ts";
import { theme } from "@danielfgray/amux";
import { Service as Integration, type Info as IntegrationInfo } from "./integration.ts";
import { Credential } from "./credential.ts";

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
  inject: [
    BindingsTag,
    OptionsTag,
    PanelTag,
    RegionsTag,
    SessionStreamTag,
    SessionViewsTag,
    SettingsTag,
    SpawnProvidersTag,
  ],
  effect: () =>
    Effect.gen(function* () {
      const bindings = yield* BindingsTag;
      const options = yield* OptionsTag;
      const panel = yield* PanelTag;
      const sessionStream = yield* SessionStreamTag;
      const sessionViews = yield* SessionViewsTag;
      const settings = yield* SettingsTag;
      const spawnProviders = yield* SpawnProvidersTag;
      const runtime = yield* Effect.context();
      yield* Effect.all(
        Object.entries(AGENT_HARNESS_OPTIONS).map(([name, spec]) => options.register([name, spec])),
      );
      const openModelPicker = (yield* registerModelPicker).pipe(Effect.provide(llmServices));
      const [providers, setProviders] = createSignal<readonly IntegrationInfo[]>([]);
      // The API-key input only takes keyboard focus in this mode, and while it
      // does this section's `keys` returns `false` so the settings window
      // stops preventDefaulting and the keystroke actually reaches the input.
      const [editing, setEditing] = createSignal(false);
      const refreshProviders = Effect.gen(function* () {
        const integrations = yield* Integration;
        setProviders(yield* integrations.list);
      }).pipe(Effect.provide(llmServices));
      yield* Effect.forkScoped(refreshProviders);
      yield* settings.register({
        id: "auth",
        label: "auth",
        rows: () => providers().length,
        keys: (event: KeyEvent, selected: number) => {
          if (editing()) {
            // Escape backs out of editing rather than closing the whole
            // settings window, so it doesn't need to double as "cancel" and
            // "quit" — every other key, "q" included, is a plain character
            // for the input to receive.
            if (event.name === "escape") {
              setEditing(false);
              return true;
            }
            return false;
          }
          if (event.name === "return" || event.name === "enter") {
            setEditing(true);
            return true;
          }
          if (event.name === "d") {
            const connection = providers()[selected]?.connections[0];
            if (connection)
              Effect.runForkWith(runtime)(
                yieldCredential().pipe(
                  Effect.flatMap((credentials) => credentials.remove(connection.id)),
                  Effect.provide(Credential.Default.pipe(Layer.provideMerge(BunFileSystem.layer))),
                  Effect.tap(() => refreshProviders),
                ),
              );
          }
        },
        component: (props) => (
          <AuthSettings
            providers={providers()}
            selected={props.selected}
            editing={editing()}
            onSubmit={(key) => {
              connect(providers()[props.selected], key);
              setEditing(false);
            }}
          />
        ),
      });

      // A binding's effect is built once, so the option has to be read inside
      // it: `agent.model` is settings the user changes while amux runs, and a
      // value captured here would be whichever model was configured at startup.
      const start = Effect.suspend(() =>
        agentPreflight(panel.options()["agent.model"] as string),
      ).pipe(
        Effect.flatMap(() =>
          panel.run({
            ...runtimeCommand("agent.new"),
            provider: "native",
          }),
        ),
        Effect.asVoid,
        Effect.provide(llmServices),
      );

      yield* spawnProviders.register([
        "native",
        () => ({
          argv: [process.execPath, new URL("./native-worker.ts", import.meta.url).pathname],
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

      yield* bindings.register({
        name: "session.next-blocked",
        key: "<leader>a",
        desc: "jump to the next blocked agent",
        group: "sessions",
        run: panel.run(command("session.next-blocked")).pipe(Effect.asVoid),
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

      const run = (value: Parameters<typeof panel.run>[0]) =>
        Effect.runForkWith(runtime)(
          panel
            .run(value)
            .pipe(Effect.catch((error) => Effect.sync(() => panel.reportError(error.message)))),
        );

      yield* sessionViews.register([
        "native",
        (props) => (
          <Chat
            {...props}
            model={panel.options()["agent.model"] as string}
            showThinking={panel.options()["agent.showThinking"] as boolean}
            onSlashCommand={(command) => {
              if (command !== "/model") return false;
              Effect.runForkWith(runtime)(openModelPicker);
              return true;
            }}
            slashCommands={[{ name: "model", description: "choose the agent model" }]}
            frames={sessionStream.frames}
            sync={sessionStream.sync}
            onSubmit={(message) =>
              run(
                runtimeCommand("agent.prompt", {
                  target: props.sessionId,
                  text: message,
                }),
              )
            }
            onPermission={(request, decision, feedback) =>
              run(
                runtimeCommand(
                  "agent.permission",
                  feedback
                    ? { session: props.sessionId, request, decision, feedback }
                    : { session: props.sessionId, request, decision },
                ),
              )
            }
            onInterrupt={() => run(runtimeCommand("agent.interrupt", { session: props.sessionId }))}
          />
        ),
      ]);

      function yieldCredential() {
        return Credential.Service;
      }
      const connect = (provider: IntegrationInfo | undefined, key: string) => {
        if (!provider || !key) return;
        Effect.runForkWith(runtime)(
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
            Effect.provide(Credential.Default.pipe(Layer.provideMerge(BunFileSystem.layer))),
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

export function AuthSettings(props: {
  readonly providers: readonly IntegrationInfo[];
  readonly selected: number;
  readonly editing: boolean;
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
        placeholder={
          props.editing ? "API key, then enter" : "j/k select · d remove · enter to set key"
        }
        value={key()}
        focused={props.editing}
        onInput={(value: string) => setKey(value)}
        onSubmit={() => {
          props.onSubmit(key());
          setKey("");
        }}
      />
    </box>
  );
}
