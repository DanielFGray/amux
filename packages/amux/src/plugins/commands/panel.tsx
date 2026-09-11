/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import type { FloatOccupant, OverlayOccupant } from "../../ui/slots.ts";
import { CommandPalette } from "../../ui/CommandPalette.tsx";
import { Prompt, type PromptRequest } from "../../ui/Prompt.tsx";
import { Hints } from "../../ui/Hints.tsx";
import { ErrorSnack } from "../../ui/ErrorSnack.tsx";
import type { OverlayService } from "../../plugin/overlay.ts";
import type { CommandsChrome } from "../../plugin/chrome.ts";

export const palettePanel = (chrome: CommandsChrome, overlay: OverlayService): OverlayOccupant => ({
  id: "amux.palette",
  // Same rung as settings: one signal holds both, so they cannot be up at
  // the same time.
  title: "commands",
  visible: () => overlay.is("palette"),
  component: (props) => (
    <CommandPalette
      entries={[...chrome.entries()]}
      query={chrome.query()}
      selected={chrome.selected()}
      width={props.width}
      onInput={(value) => {
        chrome.setQuery(value);
        chrome.setSelected(0);
      }}
      onSubmit={chrome.submit}
    />
  ),
});

export const promptPanel = (chrome: CommandsChrome): OverlayOccupant => ({
  id: "amux.prompt",
  title: "prompt",
  visible: () => chrome.prompt() !== null,
  component: (props) => (
    <Show when={chrome.prompt()} keyed>
      {(request: PromptRequest) => (
        <Prompt request={request} width={props.width} error={chrome.promptError()} />
      )}
    </Show>
  ),
});

export const hintsPanel = (chrome: CommandsChrome): FloatOccupant => ({
  id: "amux.hints",
  title: "which-key",
  // Visibility is completed at registration time (topOverlay check needs Slots).
  visible: () => chrome.hintsVisible() && chrome.hints().length > 0,
  component: (props) => (
    <Hints
      groups={[...chrome.hints()]}
      pending={chrome.pending()}
      left={props.left}
      width={props.width}
      height={props.height}
    />
  ),
});

export const errorPanel = (chrome: CommandsChrome): FloatOccupant => ({
  id: "amux.error",
  title: "error",
  visible: () => chrome.commandError() !== null,
  component: (props) => (
    <ErrorSnack
      message={chrome.commandError() ?? ""}
      left={props.left}
      width={props.width}
      onClose={chrome.clearCommandError}
      onShowMore={chrome.showCommandConsole}
    />
  ),
});
