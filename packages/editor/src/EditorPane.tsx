/** @jsxImportSource @opentui/solid */
/**
 * The editor's view: a Solid component that runs the vim state machine.
 *
 * The state machine in `vim-core.ts` is pure — it answers every keystroke
 * with a new state and a request the shell must fulfil. This component is
 * that shell. It holds the state in an `Effect.Ref`, feeds keys through
 * `captureKeys` into an `Effect.Queue`, and the queue is drained by a
 * single `Effect.forever` fiber that fulfils the machine's requests
 * (read a file, write one, close the pane) against the `EditorIo` service
 * the plugin activation captured and handed in through `props.io`.
 *
 * A pane is a viewport, so only the lines the pane can show are rendered:
 * a 10,000-line buffer draws ~40 rows, not 10,000. The view scrolls to keep
 * the cursor centred; the status bar names the mode, the file, the cursor
 * position and whether the buffer is dirty.
 *
 * The Solid render tree (the JSX below) is intentionally a Solid tree —
 * `captureKeys` is how OpenTUI hands the focused pane unclaimed keys.
 * The state lives in the `createSignal` the JSX reads; the drainer is its
 * only writer, so the render never lags the state.
 */
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Schema as S,
} from "effect";
import { command } from "@danielfgray/amux";
import type { Command, PaneViewProps } from "@danielfgray/amux";
import { theme } from "@danielfgray/amux";
import type { KeyEvent } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import {
  EditorDescriptorOrNull,
  EditorIo,
  type EditorIoService,
  type EditorReadResult,
} from "./io.ts";
import { Phase, type EditorState } from "./schema.ts";
import { initialEditor, reduceEditor } from "./vim-core.ts";
import type { HighlightProviderService, LineChunks } from "@danielfgray/amux-highlight";

export interface EditorViewProps extends PaneViewProps {
  /** Run a workspace command through the daemon's model queue. The editor is
   *  a client-only view, so everything it mutates that the daemon owns —
   *  opening a pane, recording which file it shows, closing itself — goes
   *  through here and never touches a local copy. Failures are reported to the
   *  user by the caller, so this never throws. */
  readonly run: (value: Command) => void;
  /** The directory the pane's space roots relative paths at. */
  readonly spaceDir: string;
  /** Whether the render shows the line-number gutter. */
  readonly lineNumbers: () => boolean;
  /** The filesystem service, captured by the plugin activation. The view
   *  function runs after `Effect.gen` has finished, so the activation
   *  has to hand the implementation in through the props. */
  readonly io: EditorIoService;
  /** Publish this pane's controller to the plugin's mode contexts. */
  readonly registerController?: (controller: EditorController) => () => void;
  /** Tree-sitter highlight provider, built by the plugin activation. Absent
   *  when tests mount the view directly without highlighting — the pane then
   *  renders plain text. */
  readonly highlight?: HighlightProviderService;
}

export interface EditorController {
  readonly active: () => boolean;
  readonly state: () => EditorState;
  readonly dispatch: (key: KeyEvent, count?: number) => void;
}

export function EditorPane(props: EditorViewProps) {
  const { state, chunks } = createEditorBuffer(props);
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
              chunks={chunks()?.get(visible().start + index())}
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

/**
 * Build the editor's state buffer. Holds the state signal, the
 * `Queue<KeyEvent>`, the `Ref<Phase>`, and the drainer fiber.
 *
 * The queue is created inside the forked program (its ownership is the
 * program's) and the synchronous key handler waits for the program to
 * publish it via a `Deferred`. Host keystrokes posted before the fork
 * has scheduled are queued in a small buffer; the handler drains the
 * buffer once the queue is live.
 *
 * The drainer runs in a long-lived fiber; cleanup interrupts the fiber.
 * The race where an I/O completion overwrites a later edit is gone:
 * the only writer to the state is the fiber, and the fiber is gone.
 */
function createEditorBuffer(props: EditorViewProps) {
  const io = props.io;
  const [snapshot, setSnapshot] = createSignal<EditorState>(initialEditor());
  const [chunks, setChunks] = createSignal<LineChunks | null>(null);
  // The file the provider currently highlights. Only the drainer's responses
  // for this file reach the screen — a `:e` clears stale colors, and the
  // provider itself drops stale versions.
  let currentFile: string | null = null;

  const store: EditorStore = {
    get: Effect.sync(snapshot),
    update: (f) => Effect.sync(() => setSnapshot(f)),
  };

  /** Mirror a state transition into the highlight provider: a new file opens
   *  (or replaces) a tree-sitter buffer, changed lines push an update, and a
   *  closed file forgets its colors. Reference equality on `lines` is the
   *  change signal — the reducer allocates a new array only when text edits. */
  const syncHighlight = (prev: EditorState, next: EditorState): Effect.Effect<void> => {
    const highlight = props.highlight;
    if (highlight === undefined) return Effect.void;
    return Effect.gen(function* () {
      if (next.file === null) {
        if (currentFile !== null) yield* forgetFile();
        return;
      }
      if (currentFile !== next.file) {
        if (currentFile !== null) yield* highlight.close(currentFile);
        currentFile = next.file;
        yield* Effect.sync(() => setChunks(null));
        yield* highlight.open(next.file, next.lines.join("\n"));
        return;
      }
      if (next.lines !== prev.lines) {
        yield* highlight.update(next.file, next.lines.join("\n"));
      }
    });
  };

  /** Close the provider buffer and clear the screen's colors. Used on `:q`,
   *  `:wq`, and unmount. */
  function forgetFile(): Effect.Effect<void> {
    const highlight = props.highlight;
    const file = currentFile;
    currentFile = null;
    return Effect.gen(function* () {
      yield* Effect.sync(() => setChunks(null));
      if (highlight !== undefined && file !== null) yield* highlight.close(file);
    });
  }

  /** Every state write flows through here so the provider cannot miss a
   *  transition the shell fulfils off the key path (`:e` loads, `:w` acks). */
  const updateAndSync = (f: (state: EditorState) => EditorState): Effect.Effect<void> =>
    Effect.gen(function* () {
      const prev = yield* store.get;
      yield* store.update(f);
      const next = yield* store.get;
      yield* syncHighlight(prev, next);
    });

  // Pre-fork buffer: keystrokes that arrive before the program has
  // published its queue land here, and the handler drains them once the
  // queue is live.
  type EditorInput = { readonly key: KeyEvent; readonly count?: number };
  const preBuffer: EditorInput[] = [];

  const keysDeferred = Deferred.makeUnsafe<Queue.Queue<EditorInput>>();

  const shellOf = (phaseRef: Ref.Ref<Phase>): EditorShell => ({
    props,
    io,
    store,
    phaseRef,
    updateAndSync,
    forgetFile,
  });

  const program = Effect.scoped(
    Effect.gen(function* () {
      const phaseRef = yield* Ref.make<Phase>(Phase.cases.Ready.make({}));
      const keys = yield* Queue.unbounded<EditorInput>();
      yield* Deferred.succeed(keysDeferred, keys);

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const input = yield* Queue.take(keys);
            if ((yield* Ref.get(phaseRef))._tag === "Closed") return;
            const current = yield* store.get;
            const counted =
              input.count === undefined ? current : { ...current, count: String(input.count) };
            const next = reduceEditor(counted, { _tag: "key", key: input.key });
            yield* updateAndSync(() => next);
            const request = next.request;
            if (request === null) return;
            if (request._tag === "close") {
              yield* Ref.set(phaseRef, Phase.cases.Closed.make({}));
              yield* forgetFile();
              props.run(command("pane.close", { pane: props.paneId }));
              return;
            }
            yield* Ref.set(phaseRef, Phase.cases.Io.make({}));
            yield* fulfill(shellOf(phaseRef), next, request);
          }),
        ),
      );

      // The descriptor's file is opened on mount. Validation is at the
      // boundary, not behind a chain of `typeof` guards.
      const descriptor = S.decodeUnknownOption(EditorDescriptorOrNull)(props.descriptor);
      if (descriptor._tag === "Some" && descriptor.value !== null) {
        yield* dispatchOpen(shellOf(phaseRef), descriptor.value.file, false);
      }

      return yield* Effect.never;
    }),
  );

  const programFiber = Effect.runForkWith(Context.make(EditorIo, io))(program);

  const unsubscribeHighlight = props.highlight?.subscribe((_file, _version, next) => {
    if (_file === currentFile) setChunks(next);
  });

  const enqueue = (key: KeyEvent, count?: number) => {
    const live = Effect.runSyncWith(Context.make(EditorIo, io))(
      Deferred.poll(keysDeferred).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(null as Queue.Queue<EditorInput> | null),
            onSome: (effect) => effect as Effect.Effect<Queue.Queue<EditorInput>>,
          }),
        ),
      ),
    );
    if (live === null) {
      preBuffer.push({ key, count });
      return;
    }
    for (const buffered of preBuffer.splice(0)) Queue.offerUnsafe(live, buffered);
    Queue.offerUnsafe(live, { key, count });
  };

  const controller: EditorController = {
    active: props.active,
    state: snapshot,
    dispatch: enqueue,
  };
  const unregister = props.registerController?.(controller);

  // Insert text has no finite binding table. It remains at the bottom of the
  // input chain; normal-mode keys are claimed by the plugin's contexts.
  props.captureKeys((key) => {
    if (key === null || snapshot().mode !== "insert") return false;
    enqueue(key);
    return true;
  });

  onCleanup(() => {
    const runtime = Context.make(EditorIo, io);
    Effect.runForkWith(runtime)(Fiber.interrupt(programFiber));
    unsubscribeHighlight?.();
    // The drainer is gone, so close the tree-sitter buffer directly: the
    // provider never fails, and an orphan buffer would highlight nothing.
    if (currentFile !== null && props.highlight !== undefined) {
      const file = currentFile;
      currentFile = null;
      Effect.runForkWith(runtime)(props.highlight.close(file));
    }
    unregister?.();
  });

  return { state: snapshot, chunks };
}

/**
 * The editor's state, as the drainer fiber sees it.
 *
 * Backed by the same Solid signal the JSX renders from, because the drainer is
 * its only writer: an `Effect.Ref` beside the signal would be a second copy of
 * one value, and the render would lag it by however often something polled.
 */
interface EditorStore {
  readonly get: Effect.Effect<EditorState>;
  readonly update: (f: (state: EditorState) => EditorState) => Effect.Effect<void>;
}

/** The drainer's shared shell: everything `dispatchOpen` and `fulfill`
 *  need besides their per-call arguments. Bundled so neither helper
 *  grows a six-parameter list. State writes go through `updateAndSync` so
 *  the highlight provider mirrors `:e` loads, not just keystrokes. */
interface EditorShell {
  readonly props: EditorViewProps;
  readonly io: EditorIoService;
  readonly store: EditorStore;
  readonly phaseRef: Ref.Ref<Phase>;
  readonly updateAndSync: (f: (state: EditorState) => EditorState) => Effect.Effect<void>;
  readonly forgetFile: () => Effect.Effect<void>;
}
/** Fulfill an `open` request: read the file, push the `loaded` event, then
 *  record the file in the pane descriptor if `recordDescriptor`. */
const dispatchOpen = (shell: EditorShell, file: string, recordDescriptor: boolean) =>
  Effect.gen(function* () {
    const { props, io, phaseRef, updateAndSync } = shell;
    yield* Ref.set(phaseRef, Phase.cases.Io.make({}));
    const exit = yield* Effect.exit(io.read(file, props.spaceDir));
    if (Exit.isSuccess(exit)) {
      const result: EditorReadResult = exit.value;
      yield* updateAndSync((s) =>
        reduceEditor(s, { _tag: "loaded", file: result.file, lines: result.lines }),
      );
      if (recordDescriptor) {
        props.run(
          command("pane.set-descriptor", { pane: props.paneId, descriptor: { file: result.file } }),
        );
      }
    } else {
      const message = Cause.squash(exit.cause);
      yield* updateAndSync((s) => ({
        ...s,
        request: null,
        message: `read failed: ${message instanceof Error ? message.message : String(message)}`,
      }));
    }
    yield* Ref.set(phaseRef, Phase.cases.Ready.make({}));
  });

/** Fulfill a write, write-close, or open request from the drainer. */
const fulfill = (
  shell: EditorShell,
  state: EditorState,
  request: Extract<EditorState["request"], { _tag: "open" | "write" | "write-close" }>,
) =>
  Effect.gen(function* () {
    const { props, io, phaseRef, updateAndSync, forgetFile } = shell;
    if (request._tag === "open") {
      yield* dispatchOpen(shell, request.path, true);
      return;
    }
    if (state.file === null) {
      yield* updateAndSync((s) =>
        reduceEditor(s, { _tag: "write-error", message: "no file name (open one with :e path)" }),
      );
      yield* Ref.set(phaseRef, Phase.cases.Ready.make({}));
      return;
    }
    const exit = yield* Effect.exit(io.write(state.file, state.lines, props.spaceDir));
    if (Exit.isSuccess(exit)) {
      yield* updateAndSync((s) => reduceEditor(s, { _tag: "written" }));
      if (request._tag === "write-close") {
        yield* Ref.set(phaseRef, Phase.cases.Closed.make({}));
        yield* forgetFile();
        props.run(command("pane.close", { pane: props.paneId }));
      }
    } else {
      const message = Cause.squash(exit.cause);
      yield* updateAndSync((s) =>
        reduceEditor(s, {
          _tag: "write-error",
          message: message instanceof Error ? message.message : String(message),
        }),
      );
    }
    yield* Ref.set(phaseRef, Phase.cases.Ready.make({}));
  });

function LineRow(props: {
  text: string;
  number: number | null;
  cursor: number;
  chunks?: readonly TextChunk[];
}) {
  const styled = () => props.chunks !== undefined && props.chunks.length > 0;
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <Show when={props.number !== null}>
        <text style={{ width: 4, flexShrink: 0, fg: theme.overlay1 }}>{props.number}</text>
      </Show>
      <Show
        when={styled()}
        fallback={<text style={{ flexGrow: 1, fg: theme.text }}>{props.text}</text>}
      >
        <For each={props.chunks!}>
          {(chunk) => (
            <text style={{ flexShrink: 0, fg: chunk.fg ?? theme.text }}>{chunk.text}</text>
          )}
        </For>
      </Show>
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
