/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree event handlers and lifecycle control flow belong to OpenTUI/Solid, not the service Effect graph. */
import { createSignal, Show } from "solid-js";
import { Effect, Scope } from "effect";
import type { KeyEvent } from "@opentui/core";
import { Service as Integration } from "./integration.ts";
import {
  availableThinkingLevels,
  Service as ModelCatalog,
  type Provider,
} from "./model-catalog.ts";
import {
  CONTEXT_PRIORITY,
  ContextsTag,
  CurrentPlugin,
  PanelTag,
  SlotsTag,
  type ContextSpec,
  type OverlayOccupant,
} from "@danielfgray/amux";
import {
  filterEntries as filterPickerEntries,
  ModalPicker,
  type CompletionItem,
} from "@danielfgray/amux-plugin-completion";

export interface ModelPickerEntry {
  readonly value: string;
  readonly provider: string;
  readonly name: string;
  readonly description: string;
  readonly thinkingLevels: readonly string[] | undefined;
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
export const registerModelPicker: Effect.Effect<
  Effect.Effect<void, never, Integration | ModelCatalog>,
  never,
  SlotsTag | ContextsTag | PanelTag | CurrentPlugin | Scope.Scope
> = Effect.gen(function* () {
  const panel = yield* PanelTag;
  const [view, setView] = createSignal<ModelPickerView | null>(null);

  const choose = () => {
    const current = view();
    const entry = current?.entries[current.selected];
    if (!entry) return;
    panel.setOption("agent.model", entry.value);
    // Clamp (or clear) thinking so a previous model's effort does not linger
    // on a model that does not advertise it.
    const levels = entry.thinkingLevels;
    const thinking = panel.options()["agent.thinking"] as string;
    if (levels === undefined || levels.length === 0) {
      if (thinking !== "") panel.setOption("agent.thinking", "");
    } else if (thinking !== "" && !levels.includes(thinking)) {
      panel.setOption("agent.thinking", levels[0]!);
    }
    setView(null);
    panel.saveOptions();
  };

  // Not a discrete binding: every key here reads the live selection, which
  // no static keymap sequence can express. See amux's own overlays
  // (app.tsx's `*OverlayKeys` functions) for the same shape.
  function keys(event: KeyEvent): boolean {
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
  }

  const slots = yield* SlotsTag;
  const contexts = yield* ContextsTag;
  const runtime = yield* Effect.context();
  const occupant: OverlayOccupant = {
    id: "amux.agent-harness.model-picker",
    title: "model picker",
    visible: () => view() !== null,
    component: (props) => (
      <Show when={view()}>
        {(current: () => ModelPickerView) => (
          <ModalPicker
            view={modelPickerView(current())}
            width={props.width}
            title=" choose native agent model "
            filterPlaceholder="filter models"
            onInput={(query) => setView((v) => v && filterEntries(v, query))}
            onPick={(selected) => {
              setView((v) => v && { ...v, selected });
              choose();
            }}
            onSubmit={choose}
          />
        )}
      </Show>
    ),
  };
  // Overlay slot deferred until open — OpenTUI hasInitialOutput trap (see file-ui).
  let overlayReady = false;
  const ensureOverlay = () => {
    if (overlayReady) return;
    overlayReady = true;
    Effect.runForkWith(runtime)(
      slots.register({
        slot: "overlay",
        occupant,
        priority: 15,
      }),
    );
  };
  const context: ContextSpec = {
    id: "amux.agent-harness.model-picker",
    active: () => view() !== null,
    // Same rung as the slot priority above, shifted into the OVERLAY band —
    // see amux's own overlay contexts (app.tsx) for the same convention.
    priority: CONTEXT_PRIORITY.OVERLAY + 15,
    rebindable: false,
    handle: keys,
  };
  yield* contexts.register(context);

  return yield* Effect.succeed(
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog;
      const integrations = yield* Integration;
      const providers = yield* catalog.providers;
      const connected = new Set(
        (yield* integrations.list)
          .filter((integration) => integration.connections.length > 0)
          .map((integration) => integration.id),
      );
      const entries = modelEntries(providers, connected);
      const selected = entries.findIndex((entry) => entry.value === panel.options()["agent.model"]);
      setView({ allEntries: entries, entries, query: "", selected: Math.max(0, selected) });
      ensureOverlay();
    }),
  );
});

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
          thinkingLevels: availableThinkingLevels(model),
        })),
    )
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

export function filterEntries(view: ModelPickerView, query: string): ModelPickerView {
  return filterPickerEntries(
    view,
    query,
    (entry) => `${entry.value} ${entry.provider} ${entry.name} ${entry.description}`,
  );
}

const modelPickerView = (view: ModelPickerView) => ({
  ...view,
  allEntries: view.allEntries.map(modelPickerItem),
  entries: view.entries.map(modelPickerItem),
});

const modelPickerItem = (entry: ModelPickerEntry): CompletionItem => ({
  id: entry.value,
  label: `${entry.provider} · ${entry.name}`,
  detail: entry.description,
  replacement: entry.value,
});
