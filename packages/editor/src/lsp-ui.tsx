/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree event handlers and lifecycle control flow belong to OpenTUI/Solid, not the service Effect graph. */
/**
 * LSP overlays for the editor: location picker, rename prompt, and generic
 * preview picker (code action / code lens). Same shape as the harness model
 * picker — slots + overlay-band context, view signal owned here.
 *
 * One overlay occupant hosts every mode: a second occupant failed to paint
 * under Slot mode=replace. Keep them on the proven registration path.
 */
import { createSignal, Show } from "solid-js";
import { Effect, Option, Scope } from "effect";
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
  type PreviewPosition,
} from "@danielfgray/amux-plugin-completion";
import type { LspLocation } from "@danielfgray/amux-plugin-lsp";
import { locationLabel } from "./lsp-bridge.ts";

export interface LocationPickerView {
  readonly title: string;
  readonly allEntries: readonly LspLocation[];
  readonly entries: readonly LspLocation[];
  readonly query: string;
  readonly selected: number;
  readonly workspace: Option.Option<string>;
  readonly onPick: (location: LspLocation) => void;
  /** Same-file snippet source; other files show a path header only. */
  readonly previewBuffer?: LocationPreviewBuffer;
}

export interface LocationPreviewBuffer {
  readonly uri: string;
  readonly lines: readonly string[];
}

export interface RenamePromptView {
  readonly initial: string;
  readonly value: string;
  readonly onSubmit: (name: string) => void;
}

/** Generic label/id row for {@link LspUi.pickWithPreview}. */
export interface PreviewPickerItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

export interface PreviewPickerView {
  readonly title: string;
  readonly allEntries: readonly PreviewPickerItem[];
  readonly entries: readonly PreviewPickerItem[];
  readonly query: string;
  readonly selected: number;
  readonly onPreview: (item: PreviewPickerItem) => string | undefined;
  readonly onPick: (item: PreviewPickerItem) => void;
  readonly previewTitle?: string;
  readonly previewPosition?: PreviewPosition;
}

export interface LspUi {
  readonly pickLocations: (
    title: string,
    locations: readonly LspLocation[],
    workspace: Option.Option<string>,
    onPick: (location: LspLocation) => void,
    previewBuffer?: LocationPreviewBuffer,
  ) => void;
  readonly pickWithPreview: (
    title: string,
    items: readonly PreviewPickerItem[],
    onPreview: (item: PreviewPickerItem) => string | undefined,
    onPick: (item: PreviewPickerItem) => void,
    options?: {
      readonly previewTitle?: string;
      readonly previewPosition?: PreviewPosition;
    },
  ) => void;
  readonly promptRename: (initial: string, onSubmit: (name: string) => void) => void;
  readonly close: () => void;
  /** True while a locations / preview / rename picker is up. */
  readonly isOpen: () => boolean;
}

/**
 * Snippet around a location for the preview pane.
 * Same-file → buffer lines; other-file → path + range header (DocumentService read deferred).
 */
export const locationSnippetPreview = (
  location: LspLocation,
  opts: {
    readonly currentUri?: string;
    readonly lines?: readonly string[];
    readonly workspace?: Option.Option<string>;
    readonly context?: number;
  } = {},
): string => {
  const header = locationLabel(location, opts.workspace ?? Option.none());
  const context = opts.context ?? 3;
  const sameFile =
    opts.currentUri !== undefined &&
    opts.lines !== undefined &&
    location.uri === opts.currentUri;
  if (!sameFile) {
    return `${header}\n(cross-file preview deferred)`;
  }
  const lines = opts.lines!;
  const start = Math.max(0, location.range.start.line - context);
  const end = Math.min(lines.length, location.range.end.line + context + 1);
  const body = lines.slice(start, end).map((line, idx) => {
    const row = start + idx;
    const mark =
      row >= location.range.start.line && row <= location.range.end.line ? ">" : " ";
    return `${mark}${String(row + 1).padStart(4, " ")} ${line}`;
  });
  return [header, ...body].join("\n");
};

/** Register the LSP overlay; returns the imperative open API. */
export const registerLspUi: Effect.Effect<
  LspUi,
  never,
  SlotsTag | ContextsTag | CurrentPlugin | Scope.Scope
> = Effect.gen(function* () {
  const runtime = yield* Effect.context();
  const [locations, setLocations] = createSignal<LocationPickerView | null>(null);
  const [rename, setRename] = createSignal<RenamePromptView | null>(null);
  const [preview, setPreview] = createSignal<PreviewPickerView | null>(null);

  const close = () => {
    setLocations(null);
    setRename(null);
    setPreview(null);
  };

  const chooseLocation = () => {
    const current = locations();
    const entry = current?.entries[current.selected];
    if (!current || !entry) return;
    current.onPick(entry);
    setLocations(null);
  };

  const choosePreview = () => {
    const current = preview();
    const entry = current?.entries[current.selected];
    if (!current || !entry) return;
    current.onPick(entry);
    setPreview(null);
  };

  const submitRename = () => {
    const current = rename();
    if (!current) return;
    const name = current.value.trim();
    if (name.length === 0 || name === current.initial) {
      setRename(null);
      return;
    }
    current.onSubmit(name);
    setRename(null);
  };

  const locationKeys = pickerKeyHandler<LspLocation>(
    locations,
    (update) =>
      setLocations((view) => {
        if (view === null) return null;
        const next = update(view);
        return { ...view, ...next };
      }),
    { onChoose: chooseLocation, onClose: close },
  );

  const previewKeys = pickerKeyHandler<PreviewPickerItem>(
    preview,
    (update) =>
      setPreview((view) => {
        if (view === null) return null;
        const next = update(view);
        return { ...view, ...next };
      }),
    { onChoose: choosePreview, onClose: close },
  );

  // Escape/enter via picker keys; printable residue falls through to the
  // focused ModalPicker input (same contract as the app Prompt overlay).
  const renameKeys = pickerKeyHandler<CompletionItem>(
    () => {
      const current = rename();
      return current === null ? null : renamePickerView(current);
    },
    (update) =>
      setRename((view) => {
        if (view === null) return null;
        const next = update(renamePickerView(view));
        return { ...view, value: next.query };
      }),
    { onChoose: submitRename, onClose: () => setRename(null) },
  );

  function keys(event: KeyEvent): boolean {
    if (locations()) return locationKeys(event);
    if (preview()) return previewKeys(event);
    if (rename()) return renameKeys(event);
    return false;
  }

  const slots = yield* SlotsTag;
  const contexts = yield* ContextsTag;
  const open = () => locations() !== null || rename() !== null || preview() !== null;

  const occupant: OverlayOccupant = {
    id: "amux.editor.lsp-ui",
    title: "lsp",
    visible: open,
    component: (props) => (
      <>
        <Show when={locations()}>
          {(current: () => LocationPickerView) => (
            <ModalPicker
              view={locationPickerView(current())}
              width={props.width}
              title={` ${current().title} `}
              filterPlaceholder="filter locations"
              onInput={(query) => setLocations((view) => view && filterLocations(view, query))}
              onPick={(selected) => {
                setLocations((view) => view && { ...view, selected });
                chooseLocation();
              }}
              onSubmit={chooseLocation}
              preview={
                current().previewBuffer === undefined
                  ? undefined
                  : {
                      position: "right",
                      title: " snippet ",
                      onPreview: (item) => {
                        const loc = current().entries.find(
                          (entry) => locationItem(entry, current().workspace).id === item.id,
                        );
                        if (loc === undefined) return undefined;
                        const buf = current().previewBuffer!;
                        return locationSnippetPreview(loc, {
                          currentUri: buf.uri,
                          lines: buf.lines,
                          workspace: current().workspace,
                        });
                      },
                    }
              }
            />
          )}
        </Show>
        <Show when={preview()}>
          {(current: () => PreviewPickerView) => (
            <ModalPicker
              view={previewPickerView(current())}
              width={props.width}
              title={` ${current().title} `}
              filterPlaceholder="filter"
              onInput={(query) => setPreview((view) => view && filterPreview(view, query))}
              onPick={(selected) => {
                setPreview((view) => view && { ...view, selected });
                choosePreview();
              }}
              onSubmit={choosePreview}
              preview={{
                position: current().previewPosition ?? "right",
                title: current().previewTitle ?? " preview ",
                onPreview: (item) => {
                  const row = current().entries.find((entry) => entry.id === item.id);
                  return row === undefined ? undefined : current().onPreview(row);
                },
              }}
            />
          )}
        </Show>
        <Show when={rename()}>
          {(current: () => RenamePromptView) => (
            <ModalPicker
              view={renamePickerView(current())}
              width={props.width}
              title=" rename "
              filterPlaceholder="new name"
              onInput={(query) => setRename((view) => view && { ...view, value: query })}
              onPick={() => submitRename()}
              onSubmit={submitRename}
            />
          )}
        </Show>
      </>
    ),
  };

  yield* contexts.register(
    pickerOverlayContext(
      "amux.editor.lsp-ui",
      CONTEXT_PRIORITY.OVERLAY + 16,
      open,
      keys,
    ),
  );

  let overlayReady = false;
  const ensureOverlay = () => {
    if (overlayReady) return;
    overlayReady = true;
    // Same OpenTUI hasInitialOutput trap as file-ui: register once open so the
    // first paint is non-empty (gra / grx / rename would otherwise no-op).
    Effect.runForkWith(runtime)(slots.register({ slot: "overlay", occupant, priority: 16 }));
  };

  return {
    pickLocations: (title, entries, workspace, onPick, previewBuffer) => {
      setRename(null);
      setPreview(null);
      setLocations({
        title,
        allEntries: entries,
        entries,
        query: "",
        selected: 0,
        workspace,
        onPick,
        previewBuffer,
      });
      ensureOverlay();
    },
    pickWithPreview: (title, items, onPreview, onPick, options) => {
      setRename(null);
      setLocations(null);
      setPreview({
        title,
        allEntries: items,
        entries: items,
        query: "",
        selected: 0,
        onPreview,
        onPick,
        previewTitle: options?.previewTitle,
        previewPosition: options?.previewPosition,
      });
      ensureOverlay();
    },
    promptRename: (initial, onSubmit) => {
      setLocations(null);
      setPreview(null);
      setRename({ initial, value: initial, onSubmit });
      ensureOverlay();
    },
    close,
    isOpen: open,
  };
});

export function filterLocations(view: LocationPickerView, query: string): LocationPickerView {
  const filtered = filterPickerEntries(view, query, (entry) =>
    locationLabel(entry, view.workspace),
  );
  return { ...view, ...filtered };
}

export function filterPreview(view: PreviewPickerView, query: string): PreviewPickerView {
  const filtered = filterPickerEntries(view, query, (entry) =>
    entry.detail === undefined ? entry.label : `${entry.label} ${entry.detail}`,
  );
  return { ...view, ...filtered };
}

const locationPickerView = (view: LocationPickerView) => ({
  ...view,
  allEntries: view.allEntries.map((entry) => locationItem(entry, view.workspace)),
  entries: view.entries.map((entry) => locationItem(entry, view.workspace)),
});

const previewPickerView = (view: PreviewPickerView) => ({
  query: view.query,
  selected: view.selected,
  allEntries: view.allEntries.map(previewItem),
  entries: view.entries.map(previewItem),
});

const locationItem = (entry: LspLocation, workspace: Option.Option<string>): CompletionItem => {
  const label = locationLabel(entry, workspace);
  return { id: label, label, replacement: label };
};

const previewItem = (entry: PreviewPickerItem): CompletionItem => ({
  id: entry.id,
  label: entry.label,
  detail: entry.detail,
  replacement: entry.label,
});

/** Single sticky row so ModalPicker always has a choosable entry; the filter is the new name. */
const renamePickerView = (view: RenamePromptView) => {
  const label = view.value.length > 0 ? view.value : "(empty)";
  const item: CompletionItem = { id: "rename", label, replacement: view.value };
  return {
    query: view.value,
    selected: 0,
    entries: [item],
    allEntries: [item],
  };
};
