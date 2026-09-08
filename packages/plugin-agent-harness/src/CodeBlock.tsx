/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree timer control flow belongs to OpenTUI/Solid's lifecycle, not the service Effect graph. */
import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import { theme } from "@danielfgray/amux";
import {
  filetypeForInfo,
  type HighlightSnapshot,
  type LineChunks,
  type TextChunk,
} from "@danielfgray/amux-highlight";

/**
 * One fenced code block in chat text.
 *
 * The fence's info string resolves to a tree-sitter filetype; unknown or
 * untagged fences render plain and never touch the worker. Fetching is
 * debounced: assistant text streams, and a snapshot costs a worker
 * round-trip, so only the settled text is highlighted. `createResource`
 * discards responses for superseded requests.
 */
export function CodeBlock(props: {
  code: string;
  language: string;
  highlight?: HighlightSnapshot;
}) {
  const filetype = () =>
    props.language === "" ? undefined : filetypeForInfo(props.language);
  const highlight = () => props.highlight;

  const [request, setRequest] = createSignal<{ code: string; filetype: string } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const code = props.code;
    const resolved = filetype();
    clearTimeout(timer);
    if (highlight() === undefined || resolved === undefined) {
      setRequest(null);
      return;
    }
    timer = setTimeout(() => setRequest({ code, filetype: resolved }), 200);
  });
  onCleanup(() => clearTimeout(timer));

  const [chunks] = createResource(request, (value): Promise<LineChunks | null> => {
    const snapshot = highlight();
    if (snapshot === undefined) return Promise.resolve(null);
    return snapshot(value.code, value.filetype);
  });

  const lines = () => props.code.split("\n");
  return (
    <box
      style={{
        flexDirection: "column",
        width: "100%",
        flexShrink: 0,
        backgroundColor: theme.base,
        marginTop: 1,
      }}
    >
      <Show when={props.language !== ""}>
        <text style={{ height: 1, fg: theme.overlay1 }}>{props.language}</text>
      </Show>
      <For each={lines()}>
        {(line, index) => {
          const row = (): readonly TextChunk[] | undefined => chunks()?.get(index());
          const styled = () => row() !== undefined && row()!.length > 0;
          return (
            <Show
              when={styled()}
              fallback={
                // A space keeps the empty row's height.
                <text style={{ fg: theme.text }}>{line === "" ? " " : line}</text>
              }
            >
              <box style={{ flexDirection: "row", flexShrink: 0 }}>
                <For each={row()!}>
                  {(chunk) => (
                    <text style={{ flexShrink: 0, fg: chunk.fg ?? theme.text }}>
                      {chunk.text}
                    </text>
                  )}
                </For>
              </box>
            </Show>
          );
        }}
      </For>
    </box>
  );
}
