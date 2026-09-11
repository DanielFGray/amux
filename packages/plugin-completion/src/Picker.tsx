/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { theme } from "@danielfgray/amux";
import type { CompletionItem, PickerPreview, PickerView } from "./types.ts";

/** What the filter matches against. Detail rides along so `edit op` finds `:edit open`. */
export const completionText = (item: CompletionItem): string =>
  item.detail === undefined ? item.label : `${item.label} ${item.detail}`;

/** Outer height including the border: at most 8 rows, shrinks for short lists. */
const INLINE_PICKER_MAX = 8;
const INLINE_PICKER_ROWS = INLINE_PICKER_MAX - 2;
const MODAL_WIDTH_PLAIN = 78;
const MODAL_WIDTH_PREVIEW = 100;
const MODAL_MAX_HEIGHT = 18;

/** Visible window of `items` that keeps `selected` on-screen. */
export const pickerWindow = (
  length: number,
  selected: number,
  rows: number = INLINE_PICKER_ROWS,
) => {
  const cap = Math.max(1, Math.min(rows, length));
  const start = Math.max(0, Math.min(selected - cap + 1, length - cap));
  return { start, end: start + cap } as const;
};

/** Modal outer width: wider when a preview pane is attached. */
export const modalPickerWidth = (paneWidth: number, hasPreview: boolean): number => {
  const target = hasPreview ? MODAL_WIDTH_PREVIEW : MODAL_WIDTH_PLAIN;
  return Math.max(40, Math.min(paneWidth - 2, target));
};

/**
 * The popup list: what a `:` in the editor or a `/` in chat opens. Same
 * styling as the chat menu it generalizes — bordered box, capped height,
 * mauve label plus dim detail, selected row highlighted, click chooses.
 *
 * `maxHeight` alone does not clip children in OpenTUI — long lists paint
 * through the border and cover the `:` prompt. Window the rows around the
 * selection instead of relying on a scrollbox (ModalPicker still scrolls).
 */
export function InlinePicker(props: {
  items: readonly CompletionItem[];
  selected: number;
  onSelect: () => void;
  onSelectedChange: (selected: number) => void;
}) {
  const window = () => pickerWindow(props.items.length, props.selected);
  const visible = () => props.items.slice(window().start, window().end);
  const height = () => Math.min(INLINE_PICKER_MAX, visible().length + 2);

  return (
    <box
      style={{
        width: "100%",
        height: height(),
        flexDirection: "column",
        backgroundColor: theme.mantle,
        border: true,
        borderColor: theme.surface1,
        flexShrink: 0,
      }}
    >
      <For each={visible()}>
        {(item, index) => {
          const absolute = () => window().start + index();
          return (
            <box
              style={{
                height: 1,
                flexShrink: 0,
                flexDirection: "row",
                backgroundColor: absolute() === props.selected ? theme.surface1 : theme.mantle,
              }}
              onMouseUp={() => {
                props.onSelectedChange(absolute());
                props.onSelect();
              }}
            >
              <text style={{ width: 28, flexShrink: 0, fg: theme.mauve }}>{item.label}</text>
              <text style={{ flexGrow: 1, fg: theme.subtext0 }}>{item.detail ?? ""}</text>
            </box>
          );
        }}
      </For>
    </box>
  );
}

/**
 * The modal presentation: what the model picker converges onto. Same shape —
 * centered panel, filter input, scroll list that follows the selection, hint
 * line — over a generic view instead of model entries.
 *
 * Optional `preview` borrows the side-panel contract from
 * `../my-opentui-project/packages/picker` (`PickerOptions.preview`): list +
 * `onPreview(item)` text pane, default position `right`.
 */
export function ModalPicker(props: {
  view: PickerView<CompletionItem>;
  width: number;
  title: string;
  filterPlaceholder: string;
  onInput: (query: string) => void;
  onPick: (index: number) => void;
  onSubmit: () => void;
  preview?: PickerPreview<CompletionItem>;
}) {
  let list: ScrollBoxRenderable | undefined;
  let previewScroll: ScrollBoxRenderable | undefined;
  const [previewText, setPreviewText] = createSignal("");

  const previewEnabled = createMemo(() => {
    const preview = props.preview;
    if (preview === undefined) return false;
    if (preview.position === "none") return false;
    return preview.onPreview !== undefined;
  });

  const previewPosition = () => props.preview?.position ?? "right";
  const panelWidth = () => modalPickerWidth(props.width, previewEnabled());
  const isHorizontal = () => previewEnabled() && previewPosition() === "right";

  createEffect(() => {
    const box = list;
    if (!box) return;
    const selected = props.view.selected;
    const height = box.viewport?.height ?? box.height;
    if (selected < box.scrollTop) box.scrollTop = selected;
    else if (selected >= box.scrollTop + height) box.scrollTop = selected - height + 1;
  });

  createEffect(() => {
    if (!previewEnabled()) {
      setPreviewText("");
      return;
    }
    const onPreview = props.preview!.onPreview!;
    const item = props.view.entries[props.view.selected];
    if (item === undefined) {
      setPreviewText("No item selected");
      return;
    }
    const content = onPreview(item);
    setPreviewText(content ?? "");
    const box = previewScroll;
    if (box) box.scrollTop = 0;
  });

  const listPanel = () => (
    <box
      style={{
        flexDirection: "column",
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <input
        value={props.view.query}
        placeholder={props.filterPlaceholder}
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
        fallback={<text style={{ fg: theme.overlay1, height: 1 }}>No matches.</text>}
      >
        <scrollbox ref={(value) => (list = value)} style={{ flexGrow: 1, flexShrink: 1 }}>
          <For each={props.view.entries}>
            {(item, index) => (
              <box
                style={{
                  flexDirection: "row",
                  height: 1,
                  flexShrink: 0,
                  backgroundColor: index() === props.view.selected ? theme.surface1 : theme.base,
                }}
                onMouseUp={() => props.onPick(index())}
              >
                <text style={{ fg: theme.mauve, width: 28, flexShrink: 0 }}>{item.label}</text>
                <text style={{ fg: theme.subtext0, flexGrow: 1 }}>{item.detail ?? ""}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  );

  const previewPanel = () => (
    <box
      style={{
        flexDirection: "column",
        flexGrow: isHorizontal() ? 0 : 1,
        flexShrink: 1,
        width: isHorizontal() ? "40%" : "100%",
        minWidth: isHorizontal() ? 24 : 0,
        minHeight: isHorizontal() ? 0 : 4,
        border: true,
        borderColor: theme.surface1,
        backgroundColor: theme.mantle,
      }}
      title={props.preview?.title ?? " preview "}
    >
      <scrollbox ref={(value) => (previewScroll = value)} style={{ flexGrow: 1, flexShrink: 1 }}>
        <text style={{ fg: theme.subtext0 }}>{previewText()}</text>
      </scrollbox>
    </box>
  );

  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - panelWidth()) / 2)),
        top: 1,
        width: panelWidth(),
        maxHeight: MODAL_MAX_HEIGHT,
        flexDirection: "column",
        backgroundColor: theme.base,
        border: true,
        borderColor: theme.blue,
        padding: 1,
        zIndex: 250,
      }}
      title={props.title}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <box
        style={{
          flexDirection: isHorizontal() ? "row" : "column",
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
          gap: 1,
        }}
      >
        {listPanel()}
        <Show when={previewEnabled()}>{previewPanel()}</Show>
      </box>
      <text style={{ fg: theme.overlay1, height: 1, flexShrink: 0 }}>
        ↑↓ select · enter choose · esc close
      </text>
    </box>
  );
}
