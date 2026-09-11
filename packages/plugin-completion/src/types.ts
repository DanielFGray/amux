/**
 * The shared vocabulary of every picker: chat completion, the model picker,
 * and later the editor file picker and LSP method completion.
 *
 * Sources register into the completion plugin's registry; presentations
 * (inline menu, overlay modal) render a {@link PickerView} at a
 * {@link CompletionAnchor} the caller supplies.
 */

/** A trigger character a completion source claims. */
export type CompletionTrigger = "/" | "@";

export interface CompletionItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly replacement: string;
  /** A submit item runs instead of inserting: picking it answers, not edits. */
  readonly submit?: boolean;
}

/**
 * Side-panel preview for {@link ModalPicker}.
 * Cite: ../my-opentui-project/packages/picker `PickerOptions.preview`.
 */
export type PreviewPosition = "right" | "bottom" | "none";

export interface PickerPreview<TEntry> {
  readonly position?: PreviewPosition;
  /** Title for the preview panel border. */
  readonly title?: string;
  /** Called when selection changes; return plain text for the pane. */
  readonly onPreview?: (entry: TEntry) => string | undefined;
}

export interface CompletionSource {
  /** Registration identity: what collapses a reload overlap, and what keeps
   *  two sources on one trigger (slash commands and `/model`) apart. */
  readonly id: string;
  readonly trigger: CompletionTrigger;
  readonly complete: (
    query: string,
  ) => readonly CompletionItem[] | Promise<readonly CompletionItem[]>;
}

/**
 * The live token under the cursor. `start` is the offset of the trigger
 * character in the full text; `end` is one past the token end — the cursor
 * position at detection time, so replacement splices `[start, end)` and
 * mid-line completion keeps its tail.
 */
export interface ActiveCompletion {
  readonly trigger: CompletionTrigger;
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Where the picker renders for one invocation. The caller decides; the
 * picker only renders where told — never a second opinion about placement.
 */
export type CompletionAnchor =
  | { readonly kind: "cursor" }
  | { readonly kind: "pane" }
  | { readonly kind: "shell" };

/**
 * One picker's list state: the full set, the filtered set, the query that
 * produced it, and the selection. Lifted from the model picker's view shape,
 * generalized over the entry type.
 */
export interface PickerView<TEntry> {
  readonly allEntries: readonly TEntry[];
  readonly entries: readonly TEntry[];
  readonly query: string;
  readonly selected: number;
}
