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
import {
  EditorDescriptorOrNull,
  EditorIo,
  type EditorIoService,
  type EditorReadResult,
} from "./io.ts";
import { Phase, type EditorState } from "./schema.ts";
import { initialEditor, reduceEditor } from "./vim-core.ts";

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
}

export interface EditorController {
  readonly active: () => boolean;
  readonly state: () => EditorState;
  readonly dispatch: (key: KeyEvent, count?: number) => void;
}

export function EditorPane(props: EditorViewProps) {
  const { state } = createEditorBuffer(props);
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

  const store: EditorStore = {
    get: Effect.sync(snapshot),
    update: (f) => Effect.sync(() => setSnapshot(f)),
  };

  // Pre-fork buffer: keystrokes that arrive before the program has
  // published its queue land here, and the handler drains them once the
  // queue is live.
  type EditorInput = { readonly key: KeyEvent; readonly count?: number };
  const preBuffer: EditorInput[] = [];

  const keysDeferred = Deferred.makeUnsafe<Queue.Queue<EditorInput>>();

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
            const counted = input.count === undefined ? current : { ...current, count: String(input.count) };
            const next = reduceEditor(counted, { _tag: "key", key: input.key });
            yield* store.update(() => next);
            const request = next.request;
            if (request === null) return;
            if (request._tag === "close") {
              yield* Ref.set(phaseRef, Phase.cases.Closed.make({}));
              props.run(command("pane.close", { pane: props.paneId }));
              return;
            }
            yield* Ref.set(phaseRef, Phase.cases.Io.make({}));
            yield* fulfill({ props, io, store, phaseRef }, next, request);
          }),
        ),
      );

      // The descriptor's file is opened on mount. Validation is at the
      // boundary, not behind a chain of `typeof` guards.
      const descriptor = S.decodeUnknownOption(EditorDescriptorOrNull)(props.descriptor);
      if (descriptor._tag === "Some" && descriptor.value !== null) {
        yield* dispatchOpen({ props, io, store, phaseRef }, descriptor.value.file, false);
      }

      return yield* Effect.never;
    }),
  );

  const programFiber = Effect.runForkWith(Context.make(EditorIo, io))(program);

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
    Effect.runForkWith(Context.make(EditorIo, io))(Fiber.interrupt(programFiber));
    unregister?.();
  });

  return { state: snapshot };
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
 *  grows a six-parameter list. */
interface EditorShell {
  readonly props: EditorViewProps;
  readonly io: EditorIoService;
  readonly store: EditorStore;
  readonly phaseRef: Ref.Ref<Phase>;
}
/** Fulfill an `open` request: read the file, push the `loaded` event, then
 *  record the file in the pane descriptor if `recordDescriptor`. */
const dispatchOpen = (shell: EditorShell, file: string, recordDescriptor: boolean) =>
  Effect.gen(function* () {
    const { props, io, store, phaseRef } = shell;
    yield* Ref.set(phaseRef, Phase.cases.Io.make({}));
    const exit = yield* Effect.exit(io.read(file, props.spaceDir));
    if (Exit.isSuccess(exit)) {
      const result: EditorReadResult = exit.value;
      yield* store.update((s) =>
        reduceEditor(s, { _tag: "loaded", file: result.file, lines: result.lines }),
      );
      if (recordDescriptor) {
        props.run(
          command("pane.set-descriptor", { pane: props.paneId, descriptor: { file: result.file } }),
        );
      }
    } else {
      const message = Cause.squash(exit.cause);
      yield* store.update((s) => ({
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
    const { props, io, store, phaseRef } = shell;
    if (request._tag === "open") {
      yield* dispatchOpen(shell, request.path, true);
      return;
    }
    if (state.file === null) {
      yield* store.update((s) =>
        reduceEditor(s, { _tag: "write-error", message: "no file name (open one with :e path)" }),
      );
      yield* Ref.set(phaseRef, Phase.cases.Ready.make({}));
      return;
    }
    const exit = yield* Effect.exit(io.write(state.file, state.lines, props.spaceDir));
    if (Exit.isSuccess(exit)) {
      yield* store.update((s) => reduceEditor(s, { _tag: "written" }));
      if (request._tag === "write-close") {
        yield* Ref.set(phaseRef, Phase.cases.Closed.make({}));
        props.run(command("pane.close", { pane: props.paneId }));
      }
    } else {
      const message = Cause.squash(exit.cause);
      yield* store.update((s) =>
        reduceEditor(s, {
          _tag: "write-error",
          message: message instanceof Error ? message.message : String(message),
        }),
      );
    }
    yield* Ref.set(phaseRef, Phase.cases.Ready.make({}));
  });

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
