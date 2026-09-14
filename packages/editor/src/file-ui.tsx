/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree event handlers and lifecycle control flow belong to OpenTUI/Solid, not the service Effect graph. */
/**
 * Project file finder: ModalPicker over SearchService (fff). Same overlay
 * shape as LSP location pick / harness model picker — slots + overlay context.
 */
import { Show, createSignal } from "solid-js";
import { Effect, Scope } from "effect";
import type { KeyEvent } from "@opentui/core";
import {
  CONTEXT_PRIORITY,
  ContextsTag,
  CurrentPlugin,
  SlotsTag,
  type OverlayOccupant,
} from "@danielfgray/amux";
import {
  filterEntries as filterPickerEntries,
  ModalPicker,
  pickerKeyHandler,
  pickerOverlayContext,
  type CompletionItem,
} from "@danielfgray/amux-plugin-completion";
import type { FileSearch } from "@danielfgray/amux-plugin-search";

export interface FilePickerView {
  readonly title: string;
  readonly allEntries: readonly CompletionItem[];
  readonly entries: readonly CompletionItem[];
  readonly query: string;
  readonly selected: number;
  readonly onPick: (path: string) => void;
}

export interface FileUi {
  readonly pickFile: (
    title: string,
    items: readonly CompletionItem[],
    onPick: (path: string) => void,
  ) => void;
  /** Fuzzy search via SearchService; empty query lists top frecency hits. */
  readonly findFiles: (
    search: FileSearch,
    title: string,
    initialQuery: string,
    onPick: (path: string) => void,
  ) => void;
  readonly close: () => void;
  /** True while the modal picker is up — editor pane contexts must stay off. */
  readonly isOpen: () => boolean;
}

/** Register the project file-finder overlay; returns the imperative open API. */
export const registerFileUi: Effect.Effect<
  FileUi,
  never,
  SlotsTag | ContextsTag | CurrentPlugin | Scope.Scope
> = Effect.gen(function* () {
  // Explicit R: Effect.context defaults to never, which drops CurrentPlugin|Scope
  // and makes deferred slots.register fail at the runForkWith boundary.
  const runtime = yield* Effect.context<CurrentPlugin | Scope.Scope>();
  const [view, setView] = createSignal<FilePickerView | null>(null);
  let searchLive: FileSearch | null = null;
  let searchGeneration = 0;
  let overlayReady = false;

  const close = () => {
    searchLive = null;
    setView(null);
  };

  const choose = () => {
    const current = view();
    const entry = current?.entries[current.selected];
    if (!current || !entry) return;
    current.onPick(entry.id);
    close();
  };

  const keys = pickerKeyHandler<CompletionItem>(
    view,
    (update) =>
      setView((state) => {
        if (state === null) return null;
        const next = update(state);
        return { ...state, ...next };
      }),
    { onChoose: choose, onClose: close },
  );

  const applyQuery = (query: string) => {
    const current = view();
    if (current === null) return;
    if (searchLive === null) {
      setView(filterFiles(current, query));
      return;
    }
    // Keep the controlled filter input in sync immediately — search is async.
    // Cite: ModelPicker onInput setView; without this, OpenTUI resets the value
    // to the stale `view.query` on the next paint.
    setView((state) => (state === null ? null : { ...state, query }));
    const search = searchLive;
    const generation = ++searchGeneration;
    Effect.runForkWith(runtime)(
      search.searchFiles(query, { pageSize: 80 }).pipe(
        Effect.map((result) =>
          result.items.map((item): CompletionItem => ({
            id: item.relativePath,
            label: item.relativePath,
            detail: item.gitStatus,
            replacement: item.relativePath,
          })),
        ),
        Effect.catch(() => Effect.succeed([] as readonly CompletionItem[])),
        Effect.tap((items) =>
          Effect.sync(() => {
            if (generation !== searchGeneration) return;
            setView((state) =>
              state === null
                ? null
                : {
                    ...state,
                    query,
                    allEntries: items,
                    entries: items,
                    selected: 0,
                  },
            );
          }),
        ),
      ),
    );
  };

  function handle(event: KeyEvent): boolean {
    if (!view()) return false;
    return keys(event);
  }

  const slots = yield* SlotsTag;
  const contexts = yield* ContextsTag;

  // Show+accessor, not a one-shot `const current = view()` snapshot: async
  // search updates the signal while the Slot's outer Show stays mounted, and
  // a stale ModalPicker `view` prop kept painting "No matches" while choose()
  // (which reads the live signal) could still open a hit. Cite: ModelPicker.
  const occupant: OverlayOccupant = {
    id: "amux.editor.file-finder",
    title: "find files",
    visible: () => view() !== null,
    component: (props) => (
      <Show when={view()}>
        {(current: () => FilePickerView) => (
          <ModalPicker
            view={current()}
            width={props.width}
            title={` ${current().title} `}
            filterPlaceholder="find files"
            onInput={applyQuery}
            onPick={(selected) => {
              setView((state) => state && { ...state, selected });
              choose();
            }}
            onSubmit={choose}
          />
        )}
      </Show>
    ),
  };

  // Key context is cheap and must exist for which-key / overlayBlocksPane.
  // The overlay slot is deferred until first open: OpenTUI Slot drops entries
  // whose first paint is empty (`hasInitialOutput`), so a hidden-then-shown
  // ModalPicker never remounted — `<leader>/` looked like a no-op.
  yield* contexts.register(
    pickerOverlayContext(
      "amux.editor.file-ui",
      CONTEXT_PRIORITY.OVERLAY + 15,
      () => view() !== null,
      handle,
    ),
  );

  const ensureOverlay = () => {
    if (overlayReady) return;
    overlayReady = true;
    Effect.runForkWith(runtime)(slots.register({ slot: "overlay", occupant, priority: 15 }));
  };

  return {
    pickFile: (title, items, onPick) => {
      searchLive = null;
      setView({
        title,
        allEntries: items,
        entries: items,
        query: "",
        selected: 0,
        onPick,
      });
      ensureOverlay();
    },
    findFiles: (search, title, initialQuery, onPick) => {
      searchLive = search;
      setView({
        title,
        allEntries: [],
        entries: [],
        query: initialQuery,
        selected: 0,
        onPick,
      });
      ensureOverlay();
      applyQuery(initialQuery);
    },
    close,
    isOpen: () => view() !== null,
  };
});

export function filterFiles(view: FilePickerView, query: string): FilePickerView {
  const filtered = filterPickerEntries(view, query, (entry) =>
    entry.detail === undefined ? entry.label : `${entry.label} ${entry.detail}`,
  );
  return { ...view, ...filtered };
}
