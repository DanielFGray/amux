import type { KeyEvent } from "@opentui/core";
import { CONTEXT_PRIORITY, type ContextSpec } from "@danielfgray/amux";
import type { PickerView } from "./types.ts";
import { moveSelected } from "./list.ts";

export interface PickerKeyActions {
  /** Choose the current selection. */
  readonly onChoose: () => void;
  /** Dismiss without choosing. */
  readonly onClose: () => void;
}

/**
 * The keys every picker answers: up/down (and j/k in the modal) move,
 * enter chooses, escape dismisses. View-driven: the consumer holds a
 * `PickerView` signal and this handler moves it with `moveSelected`.
 * Consumers with their own selection state (chat's menu today) keep their
 * own pipeline and call the list helpers directly instead.
 *
 * Returns the consumed boolean: residue must fall through to OpenTUI focus
 * routing, so a key this handler ignores is `false`, never swallowed.
 */
export const pickerKeyHandler =
  <TEntry>(
    view: () => PickerView<TEntry> | null,
    setView: (update: (view: PickerView<TEntry>) => PickerView<TEntry>) => void,
    actions: PickerKeyActions,
  ): ((event: KeyEvent) => boolean) =>
  (event) => {
    const current = view();
    if (!current) return false;
    switch (event.name) {
      case "escape":
        actions.onClose();
        return true;
      case "j":
      case "down":
        setView((state) => moveSelected(state, 1));
        return true;
      case "k":
      case "up":
        setView((state) => moveSelected(state, -1));
        return true;
      case "return":
      case "enter":
        actions.onChoose();
        return true;
    }
    return false;
  };

/**
 * The overlay-band context a modal picker registers beside its occupant —
 * the same rung convention as the model picker, shifted into OVERLAY. The
 * caller picks the offset: sharing a band means naming a distinct priority.
 */
export const pickerOverlayContext = (
  id: string,
  priority: number = CONTEXT_PRIORITY.OVERLAY,
  visible: () => boolean,
  handle: (event: KeyEvent) => boolean,
): ContextSpec => ({
  id,
  active: visible,
  priority,
  rebindable: false,
  handle,
});
