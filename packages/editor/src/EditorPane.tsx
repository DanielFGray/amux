/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree and per-keystroke key flow belong to OpenTUI/Solid's lifecycle, not the service Effect graph. */
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { Effect, Layer } from "effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import type { KeyEvent } from "@opentui/core";
import type { PaneViewProps } from "@danielfgray/amux";
import { theme } from "@danielfgray/amux";
import { command } from "@danielfgray/amux";
import type { Command } from "@danielfgray/amux";
import { reduceEditor, initialEditor, type EditorState } from "./vim-core.ts";

export interface EditorViewProps extends PaneViewProps {
  /** Run a workspace command through the daemon's model queue. The editor is
   *  a client-only view, so everything it mutates that the daemon owns —
   *  opening a pane, recording which file it shows, closing itself — goes
   *  through here and never touches a local copy. Failures are reported to
   *  the user by the caller, so this never throws. */
  readonly run: (value: Command) => void;
  /** The directory the pane's space roots relative paths at. */
  readonly spaceDir: string;
  /** Whether the render shows the line-number gutter. */
  readonly lineNumbers: () => boolean;
}

/**
 * The editor's view: a Solid component that runs the vim state machine.
 *
 * The machine in vim-core.ts is pure — it answers every keystroke with a new
 * state and a request the shell must fulfil. This component is that shell:
 * it holds the state in a signal, feeds keys through captureKeys, and fulfils
 * the machine's requests (read a file, write one, close the pane) against the
 * real filesystem and the daemon's command queue.
 *
 * A pane is a viewport, so only the lines the pane can show are rendered:
 * a 10,000-line buffer draws ~40 rows, not 10,000. The view scrolls to keep
 * the cursor centred; the status bar names the mode, the file, the cursor
 * position and whether the buffer is dirty.
 */
export function EditorPane(props: EditorViewProps) {
  const state = createEditorBuffer(props);
  const height = () => Math.max(1, props.height() - (state().mode === "command" ? 2 : 1));
  const visible = createMemo(() => {
    const s = state();
    const rows = height();
    // Centre the cursor; clamp to the buffer.
    const start = Math.max(0, Math.min(s.cursor.row - Math.floor(rows / 2), s.lines.length - rows));
    return {
      start,
      slice: s.lines.slice(start, start + rows),
    };
  });

  const status = createMemo(() => {
    const s = state();
    const mode = s.mode === "insert" ? "-- INSERT --" : s.mode === "command" ? ":" : "";
    const file = s.file ?? "[No Name]";
    const dirty = s.dirty ? "+" : "";
    const pos = `${s.cursor.row + 1},${s.cursor.col + 1}`;
    const message = s.message ? ` ${s.message}` : "";
    return `${mode}${mode ? " " : ""}${file}${dirty}   ${pos}${message}`;
  });

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexDirection: "column", flexGrow: 1, backgroundColor: theme.base }}>
        <For each={visible().slice}>
          {(line, index) => (
            <LineRow
              text={line}
              number={props.lineNumbers() ? visible().start + index() + 1 : null}
              cursor={
                state().mode !== "command" && state().cursor.row === visible().start + index()
                  ? state().cursor.col
                  : -1
              }
            />
          )}
        </For>
      </box>
      <text style={{ height: 1, flexShrink: 0, fg: theme.subtext0, bg: theme.surface0 }}>
        {status()}
      </text>
      <Show when={state().mode === "command"}>
        <text style={{ height: 1, flexShrink: 0, fg: theme.green, bg: theme.base }}>
          :{state().command}
        </text>
      </Show>
    </box>
  );
}

/** Keys and their file operations share one order. Typing during a read or
 * save is queued, so an I/O completion cannot overwrite a later edit. */
function createEditorBuffer(props: EditorViewProps) {
  const [state, setState] = createSignal<EditorState>(initialEditor());
  const keys: KeyEvent[] = [];
  let phase: "ready" | "io" | "closed" = "ready";

  const close = () => {
    phase = "closed";
    keys.length = 0;
    props.run(command("pane.close", { pane: props.paneId }));
  };

  const finish = () => {
    phase = "ready";
    drain();
  };

  const load = (file: string, record: boolean) => {
    phase = "io";
    readFile(file, props.spaceDir).then((result) => {
      if (phase === "closed") return;
      if (result.error !== null) {
        setState((previous) => ({
          ...previous,
          request: null,
          message: `read failed: ${result.error.message}`,
        }));
      } else {
        setState((previous) =>
          reduceEditor(previous, { type: "loaded", file, lines: result.lines }),
        );
        if (record)
          props.run(command("pane.set-descriptor", { pane: props.paneId, descriptor: { file } }));
      }
      finish();
    });
  };

  function drain() {
    while (phase === "ready" && keys.length > 0) {
      const next = reduceEditor(state(), { type: "key", key: keys.shift()! });
      setState(next);
      const request = next.request;
      if (request === null) continue;
      if (request.type === "close") close();
      else if (request.type === "open") load(request.path, true);
      else {
        phase = "io";
        writeFile(next.file, next.lines, props.spaceDir, (message) => {
          if (phase === "closed") return;
          setState((previous) =>
            reduceEditor(
              previous,
              message === null ? { type: "written" } : { type: "write-error", message },
            ),
          );
          if (message === null && request.type === "write-close") close();
          else finish();
        });
      }
    }
  }

  props.captureKeys((key) => {
    if (phase !== "closed") keys.push(key);
    drain();
    return true;
  });
  onCleanup(() => {
    phase = "closed";
    keys.length = 0;
    props.captureKeys(null);
  });

  const descriptor = props.descriptor;
  if (
    descriptor !== null &&
    typeof descriptor === "object" &&
    !Array.isArray(descriptor) &&
    typeof descriptor.file === "string"
  )
    load(descriptor.file, false);
  return state;
}

function LineRow(props: { text: string; number: number | null; cursor: number }) {
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <Show when={props.number !== null}>
        <text style={{ width: 4, flexShrink: 0, fg: theme.overlay1 }}>{props.number}</text>
      </Show>
      <text style={{ flexGrow: 1, fg: theme.text }}>{props.text}</text>
      <Show when={props.cursor >= 0}>
        <text
          style={{
            position: "absolute",
            // Past the 4-wide number gutter: the char under the cursor.
            left: props.cursor + (props.number === null ? 0 : 4),
            fg: theme.base,
            bg: theme.yellow,
          }}
        >
          {props.text[props.cursor] ?? " "}
        </text>
      </Show>
    </box>
  );
}

/** Resolve a path the way :e/:w mean it: relative paths root at the pane's
 *  space directory, never at the client process's own cwd. */
const fsLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

/** Failed reads must not replace the current buffer. */
function readFile(path: string, spaceDir: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const file = pathService.resolve(spaceDir, path);
      const text = yield* fs.readFileString(file);
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      return lines;
    }).pipe(
      Effect.match({
        onSuccess: (lines) => ({ error: null, lines }),
        onFailure: (error) => ({ error, lines: [] as string[] }),
      }),
      Effect.provide(fsLayer),
    ),
  );
}

/** Write the buffer, reporting an error message or null on success. */
function writeFile(
  file: string | null,
  lines: string[],
  spaceDir: string,
  report: (message: string | null) => void,
): void {
  if (!file) {
    report("no file name (open one with :e path)");
    return;
  }
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const resolved = pathService.resolve(spaceDir, file);
      yield* fs.writeFileString(resolved, lines.join("\n") + "\n");
    }).pipe(Effect.provide(fsLayer)),
  ).then(
    () => report(null),
    (error) => report(error instanceof Error ? error.message : String(error)),
  );
}
