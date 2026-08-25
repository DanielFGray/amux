/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, Show } from "solid-js";
import { Effect, Scope } from "effect";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { theme } from "../../../ui/theme.ts";
import { Service as Integration } from "./integration.ts";
import { Service as ModelCatalog, type Provider } from "./model-catalog.ts";
import type { PluginHostContext } from "../../types.ts";
import { CurrentPlugin, RegionsTag } from "../../services.ts";

export interface ModelPickerEntry {
  readonly value: string;
  readonly provider: string;
  readonly name: string;
  readonly description: string;
}

export interface ModelPickerView {
  readonly allEntries: readonly ModelPickerEntry[];
  readonly entries: readonly ModelPickerEntry[];
  readonly query: string;
  readonly selected: number;
}

/**
 * Put the model picker on screen and answer with the effect that opens it.
 *
 * The picker is an ordinary overlay panel: the harness registers it the way any
 * plugin registers a modal, holds its own view signal, and reads and writes
 * `agent.model` through the panel context. Core neither knows a model exists nor
 * offers the plugin a way in — a second harness builds its own picker the same
 * way, over its own option.
 */
export function registerModelPicker(
  ctx: PluginHostContext,
): Effect.Effect<
  Effect.Effect<void, never, Integration | ModelCatalog>,
  never,
  RegionsTag | CurrentPlugin | Scope.Scope
> {
  return Effect.gen(function* () {
    const [view, setView] = createSignal<ModelPickerView | null>(null);

    const choose = () => {
      const current = view();
      const entry = current?.entries[current.selected];
      if (!entry) return;
      ctx.panel.setOption("agent.model", entry.value);
      setView(null);
      ctx.panel.saveOptions();
    };

    const regions = yield* RegionsTag;
    yield* regions.register({
      id: "amux.agent-harness.model-picker",
      region: "overlay",
      // Above the settings window, because the option row in it is one of the two
      // ways here and the settings stay up behind the picker.
      order: 15,
      title: "model picker",
      visible: () => view() !== null,
      keys: (event: KeyEvent) => {
        if (!view()) return true;
        switch (event.name) {
          case "escape":
            setView(null);
            return true;
          case "j":
          case "down":
            setView((v) => v && { ...v, selected: Math.min(v.entries.length - 1, v.selected + 1) });
            return true;
          case "k":
          case "up":
            setView((v) => v && { ...v, selected: Math.max(0, v.selected - 1) });
            return true;
          case "return":
          case "enter":
            choose();
            return true;
        }
        return false;
      },
      component: (props) => (
        <Show when={view()}>
          {(current: () => ModelPickerView) => (
            <ModelPicker
              view={current()}
              width={props.width}
              onInput={(query) => setView((v) => v && filterEntries(v, query))}
              onSubmit={choose}
            />
          )}
        </Show>
      ),
    });

    return yield* Effect.succeed(
      Effect.gen(function* () {
        const catalog = yield* ModelCatalog;
        const integrations = yield* Integration;
        const providers = yield* catalog.providers();
        const connected = new Set(
          (yield* integrations.list())
            .filter((integration) => integration.connections.length > 0)
            .map((integration) => integration.id),
        );
        const entries = modelEntries(providers, connected);
        const selected = entries.findIndex(
          (entry) => entry.value === ctx.panel.options()["agent.model"],
        );
        setView({ allEntries: entries, entries, query: "", selected: Math.max(0, selected) });
      }),
    );
  });
}

/** Every model a stored credential can actually reach, and that can hold a tool
 *  conversation: no deprecated model, nothing without tool calls or text in. */
export function modelEntries(
  providers: Readonly<Record<string, Provider>>,
  connected: ReadonlySet<string>,
): ModelPickerEntry[] {
  return Object.values(providers)
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models)
        .filter((model) => model.status !== "deprecated")
        .filter(
          (model) => model.tool_call && (model.modalities?.input ?? ["text"]).includes("text"),
        )
        .map((model) => ({
          value: `${provider.id}/${model.id}`,
          provider: provider.name,
          name: model.name,
          description: model.family ?? model.id,
        })),
    )
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

export function filterEntries(view: ModelPickerView, query: string): ModelPickerView {
  const needle = query.trim().toLowerCase();
  const entries = view.allEntries.filter((entry) =>
    `${entry.value} ${entry.provider} ${entry.name} ${entry.description}`
      .toLowerCase()
      .includes(needle),
  );
  return { ...view, entries, query, selected: 0 };
}

function ModelPicker(props: {
  readonly view: ModelPickerView;
  readonly width: number;
  readonly onInput: (query: string) => void;
  readonly onSubmit: () => void;
}) {
  let list: ScrollBoxRenderable | undefined;

  createEffect(() => {
    const box = list;
    if (!box) return;
    const selected = props.view.selected;
    const height = box.viewport?.height ?? box.height;
    if (selected < box.scrollTop) box.scrollTop = selected;
    else if (selected >= box.scrollTop + height) box.scrollTop = selected - height + 1;
  });

  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - 78) / 2)),
        top: 1,
        width: 78,
        maxHeight: 18,
        flexDirection: "column",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.blue,
        padding: 1,
        zIndex: 250,
      }}
      title=" choose native agent model "
      onMouseDown={(event) => event.stopPropagation()}
    >
      <input
        value={props.view.query}
        placeholder="filter models"
        focused={true}
        style={{
          backgroundColor: theme.surface1,
          textColor: theme.text,
          focusedTextColor: theme.text,
        }}
        onInput={props.onInput}
        onSubmit={props.onSubmit}
      />
      <Show
        when={props.view.entries.length > 0}
        fallback={
          <text style={{ fg: theme.overlay1, height: 1 }}>No catalog models available.</text>
        }
      >
        <scrollbox ref={(value) => (list = value)} style={{ flexGrow: 1, flexShrink: 1 }}>
          <For each={props.view.entries}>
            {(entry, index) => (
              <box
                style={{
                  flexDirection: "row",
                  height: 1,
                  flexShrink: 0,
                  backgroundColor: index() === props.view.selected ? theme.surface1 : theme.base,
                }}
              >
                <text style={{ fg: theme.mauve, width: 18, flexShrink: 0 }}>{entry.provider}</text>
                <text style={{ fg: theme.text, width: 28, flexShrink: 0 }}>{entry.name}</text>
                <text style={{ fg: theme.subtext0, flexGrow: 1 }}>{entry.description}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
        ↑↓ select · enter choose · esc close
      </text>
    </box>
  );
}
