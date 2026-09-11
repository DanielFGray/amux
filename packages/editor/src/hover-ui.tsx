/** @jsxImportSource @opentui/solid */
/**
 * Floating LSP hover body: prose + fenced code with tree-sitter colors.
 * Cite: plugin-agent-harness CodeBlock — same snapshot path, no stream debounce.
 *
 * OpenTUI does not clip children to maxHeight/width (InlinePicker) — wrap to
 * `width - 4` (border + padding, same as Hints.tsx) and set an explicit height.
 */
import { For, Match, Show, Switch, createMemo, createResource } from "solid-js";
import { Effect } from "effect";
import { theme } from "@danielfgray/amux";
import {
  filetypeForInfo,
  type HighlightProviderService,
  type LineChunks,
  type TextChunk,
} from "@danielfgray/amux-highlight";
import {
  fitHoverSegments,
  hoverContentRows,
  hoverContentWidth,
  type HoverPlacement,
  type HoverSegment,
} from "./hover-layout.ts";

export type HoverPopupView = {
  readonly text: string;
  readonly lines: readonly string[];
  readonly place: HoverPlacement;
};

/** Truncate styled chunks so a single row never paints past the box. */
const clipChunks = (chunks: readonly TextChunk[], width: number): readonly TextChunk[] => {
  if (width <= 0) return [];
  const out: TextChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (used >= width) break;
    const room = width - used;
    if (chunk.text.length <= room) {
      out.push(chunk);
      used += chunk.text.length;
    } else {
      out.push({ ...chunk, text: chunk.text.slice(0, room) });
      break;
    }
  }
  return out;
};

const StyledLine = (props: {
  line: string;
  width: number;
  chunks?: readonly TextChunk[];
}) => {
  const line = () =>
    props.line.length > props.width ? props.line.slice(0, props.width) : props.line;
  const chunks = () =>
    props.chunks !== undefined && props.chunks.length > 0
      ? clipChunks(props.chunks, props.width)
      : undefined;
  const styled = () => chunks() !== undefined && chunks()!.length > 0;
  return (
    <Show
      when={styled()}
      fallback={
        <text style={{ height: 1, flexShrink: 0, fg: theme.text }}>
          {line() === "" ? " " : line()}
        </text>
      }
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        <For each={chunks()!}>
          {(chunk) => (
            <text style={{ flexShrink: 0, fg: chunk.fg ?? theme.text }}>{chunk.text}</text>
          )}
        </For>
      </box>
    </Show>
  );
};

const HoverCode = (props: {
  code: string;
  language: string;
  width: number;
  highlight?: HighlightProviderService;
}) => {
  const [chunks] = createResource(
    () => ({ code: props.code, language: props.language, highlight: props.highlight }),
    (value): Promise<LineChunks | null> => {
      if (value.highlight === undefined) return Promise.resolve(null);
      const filetype = value.language === "" ? undefined : filetypeForInfo(value.language);
      if (filetype === undefined) return Promise.resolve(null);
      return Effect.runPromise(value.highlight.snapshot(value.code, filetype));
    },
  );
  const lines = () => (props.code.length === 0 ? [""] : props.code.split("\n"));
  // Same surface as the outer box — a nested theme.base read as a second panel.
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <For each={lines()}>
        {(line, index) => (
          <StyledLine line={line} width={props.width} chunks={chunks()?.get(index())} />
        )}
      </For>
    </box>
  );
};

const HoverProse = (props: {
  text: string;
  width: number;
  highlight?: HighlightProviderService;
}) => {
  const [chunks] = createResource(
    () => ({ text: props.text, highlight: props.highlight }),
    (value): Promise<LineChunks | null> => {
      if (value.highlight === undefined || value.text.trim() === "") return Promise.resolve(null);
      return Effect.runPromise(value.highlight.snapshot(value.text, "markdown"));
    },
  );
  const lines = () => props.text.split("\n");
  return (
    <For each={lines()}>
      {(line, index) => (
        <StyledLine line={line} width={props.width} chunks={chunks()?.get(index())} />
      )}
    </For>
  );
};

const HoverSegmentView = (props: {
  segment: HoverSegment;
  width: number;
  highlight?: HighlightProviderService;
}) => (
  <Switch>
    <Match when={props.segment.kind === "code" ? props.segment : false}>
      {(code) => (
        <HoverCode
          code={code().code}
          language={code().language}
          width={props.width}
          highlight={props.highlight}
        />
      )}
    </Match>
    <Match when={props.segment.kind === "text" ? props.segment : false}>
      {(text) => (
        <HoverProse text={text().text} width={props.width} highlight={props.highlight} />
      )}
    </Match>
  </Switch>
);

/** Absolute hover panel — positioned by the caller via `view.place`. */
export function HoverPopupBox(props: {
  view: HoverPopupView;
  highlight?: HighlightProviderService;
}) {
  const contentWidth = () => hoverContentWidth(props.view.place.width);
  const fitted = createMemo(() =>
    fitHoverSegments(
      props.view.text,
      contentWidth(),
      hoverContentRows(props.view.place.maxHeight),
    ),
  );
  // Explicit height — maxHeight alone paints through the border (InlinePicker).
  const height = () => fitted().rows + 2;
  return (
    <box
      style={{
        position: "absolute",
        left: props.view.place.left,
        top: props.view.place.top,
        width: props.view.place.width,
        height: height(),
        flexDirection: "column",
        backgroundColor: theme.mantle,
        border: true,
        borderColor: theme.yellow,
        paddingLeft: 1,
        paddingRight: 1,
        zIndex: 200,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <For each={fitted().segments}>
        {(segment) => (
          <HoverSegmentView
            segment={segment}
            width={contentWidth()}
            highlight={props.highlight}
          />
        )}
      </For>
    </box>
  );
}
