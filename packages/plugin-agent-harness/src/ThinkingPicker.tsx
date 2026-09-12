/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree event handlers and lifecycle control flow belong to OpenTUI/Solid, not the service Effect graph. */
import { createSignal, Show } from "solid-js";
import { Effect, Scope } from "effect";
import type { KeyEvent } from "@opentui/core";
import { Service as ModelCatalog, availableThinkingLevels } from "./model-catalog.ts";
import { parseModelReference } from "./options.ts";
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

export interface ThinkingPickerEntry {
  readonly value: string;
  readonly name: string;
  readonly description: string;
}

export interface ThinkingPickerView {
  readonly allEntries: readonly ThinkingPickerEntry[];
  readonly entries: readonly ThinkingPickerEntry[];
  readonly query: string;
  readonly selected: number;
}

/**
 * Overlay twin of ModelPicker for `agent.thinking`. Lists
 * `availableThinkingLevels` for the session's current `agent.model`.
 */
export const registerThinkingPicker: Effect.Effect<
  Effect.Effect<void, never, ModelCatalog>,
  never,
  SlotsTag | ContextsTag | PanelTag | CurrentPlugin | Scope.Scope
> = Effect.gen(function* () {
  const panel = yield* PanelTag;
  const [view, setView] = createSignal<ThinkingPickerView | null>(null);

  const choose = () => {
    const current = view();
    const entry = current?.entries[current.selected];
    if (!entry) return;
    panel.setOption("agent.thinking", entry.value);
    setView(null);
    panel.saveOptions();
  };

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
  // Explicit R: Effect.context defaults to never, which drops CurrentPlugin|Scope
  // and makes deferred slots.register fail at the runForkWith boundary.
  const runtime = yield* Effect.context<CurrentPlugin | Scope.Scope>();
  const occupant: OverlayOccupant = {
    id: "amux.agent-harness.thinking-picker",
    title: "thinking picker",
    visible: () => view() !== null,
    component: (props) => (
      <Show when={view()}>
        {(current: () => ThinkingPickerView) => (
          <ModalPicker
            view={thinkingPickerView(current())}
            width={props.width}
            title=" choose thinking level "
            filterPlaceholder="filter levels"
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
  let overlayReady = false;
  const ensureOverlay = () => {
    if (overlayReady) return;
    overlayReady = true;
    Effect.runForkWith(runtime)(slots.register({ slot: "overlay", occupant, priority: 15 }));
  };
  const context: ContextSpec = {
    id: "amux.agent-harness.thinking-picker",
    active: () => view() !== null,
    priority: CONTEXT_PRIORITY.OVERLAY + 15,
    rebindable: false,
    handle: keys,
  };
  yield* contexts.register(context);

  return yield* Effect.succeed(
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog;
      const reference = panel.options()["agent.model"] as string;
      const parsed = parseModelReference(reference);
      if (parsed === undefined) {
        panel.reportError(`invalid agent.model '${reference}'`);
        return;
      }
      const model = yield* catalog.model(parsed.providerID, parsed.modelID);
      const levels = model === undefined ? undefined : availableThinkingLevels(model);
      if (levels === undefined || levels.length === 0) {
        panel.reportError(
          model === undefined
            ? `model '${reference}' is not in the catalog`
            : `model '${reference}' has no controllable thinking levels`,
        );
        return;
      }
      const entries = levels.map((level) => ({
        value: level,
        name: level,
        description: level,
      }));
      const selected = entries.findIndex(
        (entry) => entry.value === panel.options()["agent.thinking"],
      );
      setView({ allEntries: entries, entries, query: "", selected: Math.max(0, selected) });
      ensureOverlay();
    }),
  );
});

export function filterEntries(view: ThinkingPickerView, query: string): ThinkingPickerView {
  return filterPickerEntries(view, query, (entry) => `${entry.value} ${entry.name}`);
}

const thinkingPickerView = (view: ThinkingPickerView) => ({
  ...view,
  allEntries: view.allEntries.map(thinkingPickerItem),
  entries: view.entries.map(thinkingPickerItem),
});

const thinkingPickerItem = (entry: ThinkingPickerEntry): CompletionItem => ({
  id: entry.value,
  label: entry.name,
  detail: entry.description,
  replacement: entry.value,
});
