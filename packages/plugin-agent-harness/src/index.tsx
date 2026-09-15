/** @jsxImportSource @opentui/solid */
import { Deferred, Effect, Fiber, Layer, Option, Redacted } from "effect";
import { For, Show, createSignal } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { command, CommandError } from "@danielfgray/amux";
import {
  agentCompactCommand,
  agentInterruptCommand,
  agentNewCommand,
  agentPermissionCommand,
  agentPromptCommand,
} from "./command-args.ts";
import { Default as IntegrationDefault, integrations } from "./integration.ts";
import { Default as ModelCatalogDefault } from "./model-catalog.ts";
import { definePlugin, type PluginDefinition } from "@danielfgray/amux";
import {
  BindingsTag,
  ContextsTag,
  OptionsTag,
  PanelTag,
  SlotsTag,
  SessionStreamTag,
  SessionViewsTag,
  SettingsTag,
  SpawnProvidersTag,
} from "@danielfgray/amux";
import { Chat } from "./Chat.tsx";
import { discoverCachedParsers, makeHighlightProvider } from "@danielfgray/amux-highlight";
import { registerModelPicker } from "./ModelPicker.tsx";
import { registerThinkingPicker } from "./ThinkingPicker.tsx";
import { registerSessionPicker } from "./SessionPicker.tsx";
import { agentPreflight } from "./preflight.ts";
import { AGENT_HARNESS_OPTIONS } from "./options.ts";
import { theme } from "@danielfgray/amux";
import { Service as Integration, type Info as IntegrationInfo } from "./integration.ts";
import type { Method } from "./integration/types.ts";
import { Credential } from "./credential.ts";
import { OAuthCancelled, type OAuthError, type OAuthFlowController } from "./oauth/types.ts";

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
    ContextsTag,
    OptionsTag,
    PanelTag,
    SlotsTag,
    SessionStreamTag,
    SessionViewsTag,
    SettingsTag,
    SpawnProvidersTag,
  ],
  effect: (ctx) =>
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
      const openThinkingPicker = (yield* registerThinkingPicker).pipe(Effect.provide(llmServices));
      const openSessionPicker = yield* registerSessionPicker;
      const [providers, setProviders] = createSignal<readonly IntegrationInfo[]>([]);
      // Auth tab focus: key paste, oauth mode pick, or oauth in-flight (incl. paste code).
      const [authPhase, setAuthPhase] = createSignal<AuthPhase>({ _tag: "idle" });
      let oauthFiber: Fiber.Fiber<void, unknown> | undefined;
      let pasteDeferred: Deferred.Deferred<string, OAuthCancelled> | undefined;

      const refreshProviders = Effect.gen(function* () {
        const integrations = yield* Integration;
        setProviders(yield* integrations.list);
      }).pipe(Effect.provide(llmServices));
      yield* Effect.forkScoped(refreshProviders);

      const cancelOAuth = () => {
        const fiber = oauthFiber;
        const deferred = pasteDeferred;
        oauthFiber = undefined;
        pasteDeferred = undefined;
        setAuthPhase({ _tag: "idle" });
        if (fiber) Effect.runForkWith(runtime)(Fiber.interrupt(fiber));
        if (deferred)
          Effect.runForkWith(runtime)(
            Deferred.fail(deferred, new OAuthCancelled({ message: "OAuth cancelled" })),
          );
      };

      yield* settings.register({
        id: "auth",
        label: "auth",
        rows: () => providers().length,
        keys: (event: KeyEvent, selected: number) => {
          const phase = authPhase();

          if (phase._tag === "key-edit" || (phase._tag === "oauth-run" && phase.waitingPaste)) {
            if (event.name === "escape") {
              if (phase._tag === "oauth-run") cancelOAuth();
              else setAuthPhase({ _tag: "idle" });
              return true;
            }
            return false;
          }

          if (phase._tag === "oauth-run") {
            if (event.name === "escape") {
              cancelOAuth();
              return true;
            }
            return true;
          }

          if (phase._tag === "oauth-mode") {
            if (event.name === "escape") {
              setAuthPhase({ _tag: "idle" });
              return true;
            }
            if (event.name === "j" || event.name === "down") {
              setAuthPhase({
                ...phase,
                modeIndex: Math.min(phase.modes.length - 1, phase.modeIndex + 1),
              });
              return true;
            }
            if (event.name === "k" || event.name === "up") {
              setAuthPhase({
                ...phase,
                modeIndex: Math.max(0, phase.modeIndex - 1),
              });
              return true;
            }
            if (event.name === "return" || event.name === "enter") {
              const provider = providers().find((row) => row.id === phase.providerId);
              const method = provider?.methods.find(
                (entry): entry is Extract<Method, { type: "oauth" }> => entry.type === "oauth",
              );
              const mode = phase.modes[phase.modeIndex]?.value ?? "auto";
              if (provider && method) {
                setAuthPhase({
                  _tag: "oauth-run",
                  mode,
                  status: mode === "paste" ? "Open the URL, then paste the code…" : "Starting…",
                  waitingPaste: false,
                });
                oauthFiber = Effect.runForkWith(runtime)(
                  connectOAuth(provider, method.login, { mode }).pipe(
                    Effect.tap(() => refreshProviders),
                    Effect.ensuring(
                      Effect.sync(() => {
                        oauthFiber = undefined;
                        pasteDeferred = undefined;
                        setAuthPhase({ _tag: "idle" });
                      }),
                    ),
                    Effect.catch((error: OAuthError) =>
                      Effect.logError("oauth login failed").pipe(
                        Effect.annotateLogs({ error: String(error) }),
                      ),
                    ),
                  ),
                );
              }
              return true;
            }
            return true;
          }

          // idle
          if (event.name === "return" || event.name === "enter") {
            const provider = providers()[selected];
            if (!provider) return true;
            const oauth = provider.methods.find(
              (entry): entry is Extract<Method, { type: "oauth" }> => entry.type === "oauth",
            );
            const keyOnly = !oauth && provider.methods.some((entry) => entry.type === "key");
            if (oauth) {
              const modes = oauthModeOptions(oauth);
              // No `mode` select → device-code / single-path OAuth: start immediately.
              if (modes.length === 0) {
                setAuthPhase({
                  _tag: "oauth-run",
                  mode: "auto",
                  status: "Starting…",
                  waitingPaste: false,
                });
                oauthFiber = Effect.runForkWith(runtime)(
                  connectOAuth(provider, oauth.login, {}).pipe(
                    Effect.tap(() => refreshProviders),
                    Effect.ensuring(
                      Effect.sync(() => {
                        oauthFiber = undefined;
                        pasteDeferred = undefined;
                        setAuthPhase({ _tag: "idle" });
                      }),
                    ),
                    Effect.catch((error: OAuthError) =>
                      Effect.logError("oauth login failed").pipe(
                        Effect.annotateLogs({ error: String(error) }),
                      ),
                    ),
                  ),
                );
                return true;
              }
              setAuthPhase({
                _tag: "oauth-mode",
                providerId: provider.id,
                modeIndex: 0,
                modes,
              });
              return true;
            }
            if (keyOnly) {
              setAuthPhase({ _tag: "key-edit" });
              return true;
            }
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
            return true;
          }
        },
        component: (props) => (
          <AuthSettings
            providers={providers()}
            selected={props.selected}
            phase={authPhase()}
            onSubmit={(value) => {
              const phase = authPhase();
              if (phase._tag === "oauth-run" && phase.waitingPaste && pasteDeferred) {
                const deferred = pasteDeferred;
                pasteDeferred = undefined;
                Effect.runForkWith(runtime)(Deferred.succeed(deferred, value));
                setAuthPhase({ ...phase, waitingPaste: false, status: "Exchanging…" });
                return;
              }
              if (phase._tag === "key-edit") {
                connect(providers()[props.selected], value);
                setAuthPhase({ _tag: "idle" });
              }
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
        Effect.flatMap(() => agentNewCommand({})),
        Effect.flatMap((cmd) => panel.run(cmd)),
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
        key: "<prefix>shift+n",
        desc: "open a chat pane with a new native agent",
        group: "agents",
        run: start,
      });

      yield* bindings.register({
        name: "session.next-blocked",
        key: "<prefix>a",
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

      yield* bindings.register({
        name: "agent.thinking",
        desc: "choose the thinking effort the native agent uses",
        group: "agents",
        run: openThinkingPicker,
      });

      yield* bindings.register({
        name: "agent.sessions",
        desc: "resume a previous native agent session",
        group: "agents",
        run: openSessionPicker,
      });

      const run = (value: Effect.Effect<Parameters<typeof panel.run>[0], CommandError>) =>
        Effect.runForkWith(runtime)(
          value.pipe(
            Effect.flatMap((cmd) => panel.run(cmd)),
            Effect.catch((error) =>
              Effect.sync(() =>
                panel.reportError(error instanceof Error ? error.message : String(error)),
              ),
            ),
          ),
        );

      // Scoped to the plugin: the worker spawns lazily on the first fence
      // and unload closes buffers, never the shared worker. Cached grammars
      // beyond the five bundled ones register first. Snapshots are the only
      // surface chat needs — fences are static text, never edited buffers.
      const highlight = yield* makeHighlightProvider(
        undefined,
        yield* discoverCachedParsers.pipe(
          Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
        ),
      );
      const snapshot = (content: string, filetype: string) =>
        Effect.runPromiseWith(runtime)(highlight.snapshot(content, filetype));

      yield* sessionViews.register([
        "native",
        (props) => (
          <Chat
            {...props}
            model={panel.options()["agent.model"] as string}
            showThinking={panel.options()["agent.showThinking"] as boolean}
            highlight={snapshot}
            onSlashCommand={(command) => {
              if (command === "/model") {
                Effect.runForkWith(runtime)(openModelPicker);
                return true;
              }
              if (command === "/thinking") {
                Effect.runForkWith(runtime)(openThinkingPicker);
                return true;
              }
              if (command === "/sessions") {
                Effect.runForkWith(runtime)(openSessionPicker);
                return true;
              }
              if (command === "/compact" || command.startsWith("/compact ")) {
                const instructions =
                  command === "/compact" ? undefined : command.slice("/compact ".length).trim();
                run(
                  instructions !== undefined && instructions !== ""
                    ? agentCompactCommand({
                        target: props.sessionId,
                        instructions,
                      })
                    : agentCompactCommand({ target: props.sessionId }),
                );
                return true;
              }
              return false;
            }}
            completionSources={[
              {
                trigger: "/",
                complete: (query) =>
                  [
                    {
                      id: "model",
                      label: "/model",
                      detail: "choose the agent model",
                      replacement: "/model",
                      submit: true,
                    },
                    {
                      id: "thinking",
                      label: "/thinking",
                      detail: "choose thinking effort",
                      replacement: "/thinking",
                      submit: true,
                    },
                    {
                      id: "sessions",
                      label: "/sessions",
                      detail: "resume a previous native agent session",
                      replacement: "/sessions",
                      submit: true,
                    },
                    {
                      id: "compact",
                      label: "/compact",
                      detail: "summarize older context to free the model window",
                      replacement: "/compact",
                      submit: true,
                    },
                  ].filter((completion) =>
                    `${completion.label} ${completion.detail}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  ),
              },
              {
                trigger: "@",
                complete: (query) =>
                  Effect.runPromiseWith(runtime)(
                    Effect.promise(() => import("@danielfgray/amux-plugin-search")).pipe(
                      Effect.flatMap((searchPlugin) =>
                        Option.match(ctx.get(searchPlugin.SearchService), {
                          onNone: () => Effect.succeed([]),
                          onSome: (search) =>
                            search.searchFiles(query, { pageSize: 12 }).pipe(
                              Effect.map((result) =>
                                result.items.map((item) => ({
                                  id: item.relativePath,
                                  label: `@${item.relativePath}`,
                                  detail: item.gitStatus,
                                  replacement: `@${item.relativePath} `,
                                })),
                              ),
                            ),
                        }),
                      ),
                      Effect.orElseSucceed(() => []),
                    ),
                  ),
              },
            ]}
            frames={sessionStream.frames}
            sync={sessionStream.sync}
            onSubmit={(message, options) => {
              if (options?.delivery !== undefined && options.replace !== undefined) {
                return run(
                  agentPromptCommand({
                    target: props.sessionId,
                    text: message,
                    delivery: options.delivery,
                    replace: options.replace,
                  }),
                );
              }
              if (options?.delivery !== undefined) {
                return run(
                  agentPromptCommand({
                    target: props.sessionId,
                    text: message,
                    delivery: options.delivery,
                  }),
                );
              }
              if (options?.replace !== undefined) {
                return run(
                  agentPromptCommand({
                    target: props.sessionId,
                    text: message,
                    replace: options.replace,
                  }),
                );
              }
              return run(
                agentPromptCommand({
                  target: props.sessionId,
                  text: message,
                }),
              );
            }}
            onPermission={(request, decision, feedback) =>
              run(
                feedback
                  ? agentPermissionCommand({
                      target: props.sessionId,
                      request,
                      decision,
                      feedback,
                    })
                  : agentPermissionCommand({ target: props.sessionId, request, decision }),
              )
            }
            onInterrupt={() => run(agentInterruptCommand({ target: props.sessionId }))}
          />
        ),
      ]);

      function yieldCredential() {
        return Credential.Service;
      }
      const connectOAuth = (
        provider: IntegrationInfo,
        login: (
          ctl: OAuthFlowController,
          answers?: Readonly<Record<string, string>>,
        ) => Effect.Effect<Credential.OAuth, OAuthError>,
        answers: Readonly<Record<string, string>>,
      ) =>
        Effect.gen(function* () {
          const credentials = yield* yieldCredential();
          const ctl: OAuthFlowController = {
            onAuth: (info) =>
              Effect.sync(() => {
                Bun.spawn(["xdg-open", info.launchUrl ?? info.url], {
                  stdout: "ignore",
                  stderr: "ignore",
                  stdin: "ignore",
                });
                setAuthPhase((phase) =>
                  phase._tag === "oauth-run"
                    ? {
                        ...phase,
                        status:
                          info.instructions ??
                          (phase.mode === "paste"
                            ? "Paste the redirect URL or code…"
                            : "Waiting for browser…"),
                      }
                    : phase,
                );
              }),
            onProgress: (message) =>
              Effect.sync(() => {
                setAuthPhase((phase) =>
                  phase._tag === "oauth-run" ? { ...phase, status: message } : phase,
                );
              }),
            onManualCodeInput: Effect.gen(function* () {
              const deferred = yield* Deferred.make<string, OAuthCancelled>();
              pasteDeferred = deferred;
              setAuthPhase((phase) =>
                phase._tag === "oauth-run"
                  ? { ...phase, waitingPaste: true, status: "Paste redirect URL or code…" }
                  : phase,
              );
              return yield* Deferred.await(deferred);
            }),
          };
          const value = yield* login(ctl, answers);
          if (provider.connections[0]) {
            yield* credentials.update(provider.connections[0].id, { value });
          } else {
            yield* credentials.create({
              integrationID: provider.id,
              value,
              label: provider.label,
            });
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(Credential.Default.pipe(Layer.provideMerge(BunFileSystem.layer))),
        );
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

type OAuthModeOption = {
  readonly label: string;
  readonly value: "auto" | "paste" | "device";
};

type AuthPhase =
  | { readonly _tag: "idle" }
  | { readonly _tag: "key-edit" }
  | {
      readonly _tag: "oauth-mode";
      readonly providerId: string;
      readonly modeIndex: number;
      readonly modes: readonly OAuthModeOption[];
    }
  | {
      readonly _tag: "oauth-run";
      readonly mode: "auto" | "paste" | "device";
      readonly status: string;
      readonly waitingPaste: boolean;
    };

/** Mode choices from an oauth method's `mode` select, or empty when the method
 *  has no mode prompt (device-code starts without a picker). */
export const oauthModeOptions = (
  method: Extract<Method, { type: "oauth" }>,
): readonly OAuthModeOption[] => {
  const select = method.prompts?.find(
    (prompt) => prompt.type === "select" && prompt.key === "mode",
  );
  if (select && select.type === "select") {
    return select.options.flatMap((option) =>
      option.value === "auto" || option.value === "paste" || option.value === "device"
        ? [{ label: option.label, value: option.value }]
        : [],
    );
  }
  return [];
};

export function AuthSettings(props: {
  readonly providers: readonly IntegrationInfo[];
  readonly selected: number;
  readonly phase: AuthPhase;
  readonly onSubmit: (value: string) => void;
}) {
  const [key, setKey] = createSignal("");
  const inputFocused = () =>
    props.phase._tag === "key-edit" ||
    (props.phase._tag === "oauth-run" && props.phase.waitingPaste);
  const placeholder = () => {
    const phase = props.phase;
    if (phase._tag === "key-edit") return "API key, then enter";
    if (phase._tag === "oauth-run" && phase.waitingPaste)
      return "Paste redirect URL or code, then enter";
    if (phase._tag === "oauth-mode") return "j/k mode · enter start · esc cancel";
    if (phase._tag === "oauth-run") return `${phase.status} · esc cancel`;
    return "j/k select · d remove · enter connect";
  };

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
      <Show when={props.phase._tag === "oauth-mode" ? props.phase : false}>
        {(phase: () => Extract<AuthPhase, { _tag: "oauth-mode" }>) => (
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            <text style={{ fg: theme.overlay1, height: 1 }}>OAuth mode</text>
            <For each={phase().modes}>
              {(mode, index) => (
                <text
                  style={{
                    fg: index() === phase().modeIndex ? theme.text : theme.overlay1,
                    height: 1,
                  }}
                >
                  {index() === phase().modeIndex ? "› " : "  "}
                  {mode.label}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
      <Show when={props.phase._tag === "oauth-run" ? props.phase.status : false}>
        {(status: () => string) => (
          <text style={{ fg: theme.overlay1, height: 1, marginTop: 1 }}>{status()}</text>
        )}
      </Show>
      <input
        placeholder={placeholder()}
        value={key()}
        focused={inputFocused()}
        onInput={(value: string) => setKey(value)}
        onSubmit={() => {
          props.onSubmit(key());
          setKey("");
        }}
      />
    </box>
  );
}
