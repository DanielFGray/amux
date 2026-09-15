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
 * a 10,000-line buffer draws ~40 rows, not 10,000. The view follows
 * `viewport.top` (Ctrl-e/y, mouse wheel) and only recentres when the cursor
 * would leave the window; the status bar names the mode, the file, the cursor
 * position and whether the buffer is dirty.
 *
 * The Solid render tree (the JSX below) is intentionally a Solid tree —
 * `captureKeys` is how OpenTUI hands the focused pane unclaimed keys.
 * The state lives in the `createSignal` the JSX reads; the drainer is its
 * only writer, so the render never lags the state. Mount-time descriptor
 * opens are queued as `boot-open` ahead of keys so a slow read cannot wipe
 * edits typed during the load (ts-d3ce27).
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Path,
  PubSub,
  Queue,
  Ref,
  Schema as S,
  Stream,
} from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { command } from "@danielfgray/amux";
import type { Command, PaneViewProps } from "@danielfgray/amux";
import { theme } from "@danielfgray/amux";
import { documentWatch, replaceDocument } from "@danielfgray/amux/document-client.ts";
import { fileUriFromPath } from "@danielfgray/amux/document-uri.ts";
import type { KeyEvent, MouseEvent } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import {
  EditorDescriptor,
  EditorDescriptorOrNull,
  EditorIo,
  type EditorIoService,
  type EditorReadResult,
} from "./io.ts";
import { Phase, type EditorEvent, type EditorState } from "./schema.ts";
import type { EditorService } from "./api.ts";
import { BUILTIN_COMMANDS } from "./api.ts";
import { editorCommandItems, initialEditor, reduceEditor } from "./vim-core.ts";
import { fileArgCompletion, fileCompletionItems, splitPathPrefix } from "./command-completion.ts";
import { editReplaceLines, linesOf, rowCount, textOf } from "./buffer-state.ts";
import { finishChange, startChange } from "./history.ts";
import { fitViewport } from "./vim-slices.ts";
import type {
  HighlightProviderService,
  LineChunks,
  TreeSitterService,
} from "@danielfgray/amux-highlight";
import { pathToFiletype } from "@opentui/core";
import {
  InlinePicker,
  filterEntries,
  type CompletionItem,
} from "@danielfgray/amux-plugin-completion";
import type { FileSearch } from "@danielfgray/amux-plugin-search";
import type { LspDiagnostic, LspDocumentClient } from "@danielfgray/amux-plugin-lsp";
import { languageForPath, type DocumentSnapshot } from "@danielfgray/amux-plugin-lsp";
import {
  applyBufferEdits,
  applyGoto,
  asLocations,
  attachEditorDocument,
  completionLabels,
  diagnosticAtCursor,
  diagnosticsSummary,
  editsByUri,
  fileUri,
  flattenDocumentSymbols,
  formatDiagnostic,
  hoverText,
  jumpDiagnostic as findDiagnosticJump,
  pathFromUri,
  publishBufferChange,
  signatureHelpText,
  wordAtCursor,
  type EditorLspServices,
} from "./lsp-bridge.ts";
import { pushJump } from "./jumps.ts";
import type { LspUi } from "./lsp-ui.tsx";
import { locationSnippetPreview } from "./lsp-ui.tsx";
import {
  decodeShowReferencesArgs,
  isLspCommand,
  type LspCodeActionItem,
  type LspCodeLens,
  type LspCommand,
  type LspLocation,
} from "@danielfgray/amux-plugin-lsp";
import { workspaceEditPreview } from "./edit-preview.ts";
import {
  HOVER_GUTTER_WIDTH,
  hoverLines,
  placeHoverPopup,
  splitHoverSegments,
} from "./hover-layout.ts";
import { HoverPopupBox, type HoverPopupView } from "./hover-ui.tsx";

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
  /** Key profile from settings (`editor.keyProfile`). */
  readonly keyProfile: () => "vim" | "cua";
  /** The filesystem service, captured by the plugin activation. The view
   *  function runs after `Effect.gen` has finished, so the activation
   *  has to hand the implementation in through the props. */
  readonly io: EditorIoService;
  /** Daemon session id when the pane should project OpenDocumentStore. */
  readonly session?: string;
  /** Live editor service (commands + keymaps). Absent in bare test mounts that
   *  only exercise builtins — reduceEditor then uses the builtin table. */
  readonly editor?: EditorService;
  /** Publish this pane's controller to the plugin's mode contexts. */
  readonly registerController?: (paneId: string, controller: EditorController) => () => void;
  /** Re-publish grammar showcmd when focus or state changes (ts-9e2f54). */
  readonly onShowcmdSync?: () => void;
  /** Tree-sitter highlight provider, built by the plugin activation. Absent
   *  when tests mount the view directly without highlighting — the pane then
   *  renders plain text. */
  readonly highlight?: HighlightProviderService;
  /**
   * Structural TreeSitter service for tag textobjects / surround. Required on
   * the editor path — web-tree-sitter is a declared dependency; a missing
   * runtime wasm fails plugin activation rather than soft-disabling tags.
   */
  readonly treeSitter: TreeSitterService;
  /** LSP document + server services when `amux.lsp` is loaded. Soft-get at
   *  call time — activation order must not freeze "absent" for the pane's life
   *  (ts-e56b4e). */
  readonly lsp?: () => EditorLspServices | undefined;
  /** Location picker + rename prompt overlays (plugin registers when LSP is up). */
  readonly lspUi?: LspUi;
  /** Optional fff-backed search when `amux.search` is loaded (`:e` Tab / find).
   *  Soft-get at call time, same reason as `lsp`. */
  readonly search?: () => FileSearch | undefined;
  /**
   * Fired when a content CmdAtom settles (`atomGeneration` bumps). Seam for
   * multicursor UI / plugins — cascade already ran inside the reducer.
   */
  readonly onAtom?: (atom: import("./cmd-atom.ts").CmdAtom) => void;
}

/**
 * This pane's controller, bound into the pane's realm.
 *
 * One editor plugin serves every editor pane, so this key has no single
 * binding — it is isolated per pane (`paneRealm(paneId)`). A command declaring
 * `Realm` resolves it to the pane its keystroke was typed into, which is what
 * replaces each command body hunting for the focused controller itself.
 */
export class EditorControllerTag extends Context.Service<EditorControllerTag, EditorController>()(
  "amux.editor/Controller",
) {}

export interface EditorController {
  readonly active: () => boolean;
  readonly state: () => EditorState;
  readonly dispatch: (key: KeyEvent, count?: number) => void;
  readonly completionVisible: () => boolean;
  readonly moveCompletion: (delta: number) => void;
  readonly chooseCompletion: () => void;
  /**
   * Tab past `:e `'s first space — arm the file picker. Returns true when
   * the line is a file-complete command so the key does not fall through to
   * name completion (which no-ops past a space).
   */
  readonly requestFileCompletion: () => boolean;
  /** Open a path in this buffer (leader file finder / LSP jump). */
  readonly openPath: (path: string) => void;
  readonly requestHover: () => void;
  readonly requestCompletion: () => void;
  readonly requestDefinition: () => void;
  readonly requestDeclaration: () => void;
  readonly requestTypeDefinition: () => void;
  readonly requestImplementation: () => void;
  readonly requestReferences: () => void;
  readonly requestRename: () => void;
  readonly requestDocumentSymbols: () => void;
  readonly requestCodeAction: () => void;
  readonly requestCodeLens: () => void;
  readonly requestSignatureHelp: () => void;
  readonly jumpDiagnostic: (kind: "next" | "prev" | "first" | "last") => void;
  readonly showDiagnosticFloat: () => void;
  /** Apply a pure state transform (builtin map runs from the chord layer). */
  readonly apply: (f: (state: EditorState) => EditorState) => void;
  /** LSP hover floating popup is open. */
  readonly hoverVisible: () => boolean;
  /** Dismiss the hover popup (Esc / any other key via the hover context). */
  readonly dismissHover: () => void;
}

export function EditorPane(props: EditorViewProps) {
  const {
    state,
    chunks,
    diagnostics,
    diagnosticLines,
    commandItems,
    selectedCompletion,
    setSelectedCompletion,
    completionVisible,
    chooseCompletion,
    scrollBy,
    hover,
  } = createEditorBuffer(props);
  createEffect(() => {
    props.active();
    state();
    props.onShowcmdSync?.();
  });
  const pickerHeight = () => (completionVisible() ? Math.min(8, commandItems().length + 2) : 0);
  const height = () =>
    Math.max(1, props.height() - (state().mode === "command" ? 2 + pickerHeight() : 1));
  const visible = createMemo(() => {
    const s = state();
    const rows = Math.max(1, Math.min(height(), s.viewport.height || height()));
    // Honour viewport.top (Ctrl-e/y, mouse wheel) — do not re-centre every frame.
    const start = Math.max(0, Math.min(s.viewport.top, Math.max(0, rowCount(s.buffer) - rows)));
    return {
      start,
      slice: linesOf(s.buffer).slice(start, start + rows),
    };
  });
  const selection = createMemo(() => {
    const s = state();
    if (s.visual === null) return null;
    // Vim visual is mode-gated; CUA keeps insert mode with a live selection.
    if (s.mode !== "visual" && s.options.keyProfile !== "cua") return null;
    const anchor = s.visual.anchor;
    const cursor = s.cursor;
    const forward =
      anchor.row < cursor.row || (anchor.row === cursor.row && anchor.col <= cursor.col);
    const from = forward ? anchor : cursor;
    const to = forward ? cursor : anchor;
    // CUA: half-open [from, to). Vim visual: inclusive endpoints.
    const inclusive = s.mode === "visual";
    if (!inclusive && from.row === to.row && from.col === to.col) return null;
    return {
      from,
      to,
      linewise: s.visual.kind === "line",
      inclusive,
    };
  });

  const status = createMemo(() => {
    const s = state();
    const profile = s.options.keyProfile;
    const mode =
      profile === "cua"
        ? "-- CUA --"
        : s.mode === "insert"
          ? "-- INSERT --"
          : s.mode === "command"
            ? ":"
            : s.mode === "visual"
              ? s.visual?.kind === "line"
                ? "-- VISUAL LINE --"
                : "-- VISUAL --"
              : s.mode === "search"
                ? s.searchDirection === "forward"
                  ? "/"
                  : "?"
                : "";
    const file = s.file ?? "[No Name]";
    const dirty = s.dirty ? "+" : "";
    const pos = `${s.cursor.row + 1},${s.cursor.col + 1}`;
    const diag = diagnosticsSummary(diagnostics());
    const message = s.message ? ` ${s.message}` : "";
    return `${mode}${mode ? " " : ""}${file}${dirty}   ${pos}${diag ? ` ${diag}` : ""}${message}`;
  });

  const onWheel = (event: MouseEvent) => {
    const dir = event.scroll?.direction;
    if (dir !== "up" && dir !== "down") return;
    // Cite: options behaviour.scrollRows default 3 (PTY wheel path).
    const rows = 3;
    scrollBy(dir === "up" ? -rows : rows);
    event.stopPropagation();
  };

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }} onMouseScroll={onWheel}>
      <box
        style={{ flexDirection: "column", flexGrow: 1, backgroundColor: theme.base }}
        onMouseScroll={onWheel}
      >
        <For each={visible().slice}>
          {(line, index) => (
            <LineRow
              text={line}
              number={state().options.number ? visible().start + index() + 1 : null}
              diagnostic={diagnosticLines().has(visible().start + index())}
              cursor={
                state().mode !== "command" && state().cursor.row === visible().start + index()
                  ? state().cursor.col
                  : -1
              }
              selection={selection()}
              row={visible().start + index()}
              chunks={chunks()?.get(visible().start + index())}
            />
          )}
        </For>
      </box>
      <text style={{ height: 1, flexShrink: 0, fg: theme.subtext0, bg: theme.surface0 }}>
        {status()}
      </text>
      <Show when={completionVisible()}>
        <InlinePicker
          items={commandItems()}
          selected={selectedCompletion()}
          onSelectedChange={setSelectedCompletion}
          onSelect={() => chooseCompletion()}
        />
      </Show>
      <Show when={state().mode === "command"}>
        <text style={{ height: 1, flexShrink: 0, fg: theme.green, bg: theme.base }}>
          :{state().command}
        </text>
      </Show>
      <Show when={state().mode === "search"}>
        <text style={{ height: 1, flexShrink: 0, fg: theme.green, bg: theme.base }}>
          {state().searchDirection === "forward" ? "/" : "?"}
          {state().command}
        </text>
      </Show>
      <Show when={hover()}>
        {(current: () => HoverPopupView) => (
          <HoverPopupBox view={current()} highlight={props.highlight} />
        )}
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
  // Solid event handlers sit outside Effect.gen; capture EditorIo once and
  // thread it through run*With (plugin.tsx / attach.ts precedent).
  const runtime = Context.make(EditorIo, io);
  const runFork = Effect.runForkWith(runtime);
  const runSync = Effect.runSyncWith(runtime);
  const commands = () => props.editor?.command.list();
  const stampViewport = (state: EditorState): EditorState =>
    // Keep cursor in view on resize / motion; never force-centre (that fought
    // Ctrl-e/y and mouse wheel). Cite: vim-slices fitViewport / scrollViewport.
    fitViewport(state, Math.max(1, props.height() - 1));
  const reduce = (state: EditorState, event: EditorEvent) => {
    // Motions use the current viewport height, while the resulting cursor must
    // also be made visible in the same transition. Stamping only before the
    // reducer left Ctrl-D/Ctrl-U one render behind: the cursor moved outside
    // the old slice and disappeared until the next key.
    const prepared = stampViewport(state);
    const next =
      event._tag === "goto"
        ? applyGoto(prepared, event.path, event.row, event.col)
        : reduceEditor(prepared, event, commands());
    return stampViewport(next);
  };
  const boot = initialEditor();
  const [snapshot, setSnapshot] = createSignal<EditorState>({
    ...boot,
    options: {
      ...boot.options,
      number: props.lineNumbers(),
      keyProfile: props.keyProfile(),
    },
  });
  // Settings options are live accessors — keep buffer options in sync without
  // remounting the pane when the user flips them in settings.
  createEffect(() => {
    const number = props.lineNumbers();
    const keyProfile = props.keyProfile();
    setSnapshot((current) => {
      if (current.options.number === number && current.options.keyProfile === keyProfile) {
        return current;
      }
      const nextMode =
        keyProfile === "cua" && current.mode === "normal" ? ("insert" as const) : current.mode;
      return {
        ...current,
        mode: nextMode,
        options: { ...current.options, number, keyProfile },
      };
    });
  });
  const [chunks, setChunks] = createSignal<LineChunks | null>(null);
  const [diagnostics, setDiagnostics] = createSignal<readonly LspDiagnostic[]>([]);
  const [lspClient, setLspClient] = createSignal<Option.Option<LspDocumentClient>>(Option.none());
  const diagnosticLines = createMemo(() => {
    const lines = new Set<number>();
    for (const diagnostic of diagnostics()) lines.add(diagnostic.range.start.line);
    return lines;
  });
  const [selectedCompletion, setSelectedCompletion] = createSignal(0);
  const [fileArmed, setFileArmed] = createSignal(false);
  const [fileItems, setFileItems] = createSignal<readonly CompletionItem[]>([]);
  const [hover, setHover] = createSignal<HoverPopupView | null>(null);
  let fileSearchGeneration = 0;
  const registeredCommands = () => props.editor?.command.list() ?? BUILTIN_COMMANDS;

  const loadFileCompletion = (head: string, prefix: string) => {
    const generation = ++fileSearchGeneration;
    const search = props.search?.();
    if (search !== undefined) {
      runFork(
        search.searchFiles(prefix, { pageSize: 40 }).pipe(
          Effect.map((result) =>
            result.items.map((item): CompletionItem => ({
              id: item.relativePath,
              label: item.relativePath,
              detail: item.gitStatus,
              replacement: `${head} ${item.relativePath}`,
            })),
          ),
          Effect.orElseSucceed(() => [] as readonly CompletionItem[]),
          Effect.tap((items) =>
            Effect.sync(() => {
              if (generation !== fileSearchGeneration) return;
              setFileItems(items);
            }),
          ),
        ),
      );
      return;
    }
    const { dir } = splitPathPrefix(prefix);
    runFork(
      props.io.listEntries(dir, props.spaceDir).pipe(
        Effect.map((entries) => fileCompletionItems(head, prefix, entries)),
        Effect.orElseSucceed(() => [] as readonly CompletionItem[]),
        Effect.tap((items) =>
          Effect.sync(() => {
            if (generation !== fileSearchGeneration) return;
            setFileItems(items);
          }),
        ),
      ),
    );
  };

  const commandItems = createMemo(() => {
    const line = snapshot().command;
    const fileArg = fileArgCompletion(line, registeredCommands());
    if (fileArg !== null) {
      if (!fileArmed()) return [];
      const items = fileItems();
      // SearchService already ranks by query; dir listing still needs a prefix filter.
      if (props.search?.() !== undefined) return items;
      return filterEntries(
        { allEntries: items, entries: items, query: "", selected: 0 },
        fileArg.prefix,
        (item) => item.label,
      ).entries;
    }
    const items = editorCommandItems(registeredCommands());
    return filterEntries(
      { allEntries: items, entries: items, query: "", selected: 0 },
      line,
      (item) => `${item.label} ${item.detail ?? ""}`,
    ).entries;
  });
  createEffect(() => {
    void snapshot().command;
    setSelectedCompletion(0);
  });
  createEffect(() => {
    const line = snapshot().command;
    if (fileArgCompletion(line, registeredCommands()) === null) {
      setFileArmed(false);
      setFileItems([]);
    }
  });
  // While the file picker is armed, keep the list in sync with the typed prefix.
  createEffect(() => {
    if (!fileArmed()) return;
    const line = snapshot().command;
    const fileArg = fileArgCompletion(line, registeredCommands());
    if (fileArg === null) return;
    loadFileCompletion(fileArg.head, fileArg.prefix);
  });
  let lastAtomGeneration = 0;
  createEffect(() => {
    const s = snapshot();
    const gen = s.atomGeneration;
    if (gen === lastAtomGeneration) return;
    lastAtomGeneration = gen;
    if (s.lastAtom !== null) props.onAtom?.(s.lastAtom);
  });
  const completionVisible = () => snapshot().mode === "command" && commandItems().length > 0;
  // The file the provider currently highlights. Only the drainer's responses
  // for this file reach the screen — a `:e` clears stale colors, and the
  // provider itself drops stale versions.
  let currentFile: string | null = null;
  let lspSessionFiber: Fiber.Fiber<void, never> | null = null;
  let lspChanges: PubSub.PubSub<DocumentSnapshot> | null = null;

  const closeLspSession = () => {
    setLspClient(Option.none());
    setDiagnostics([]);
    lspChanges = null;
    if (lspSessionFiber !== null) {
      runFork(Fiber.interrupt(lspSessionFiber));
      lspSessionFiber = null;
    }
  };

  const publishLspChange = (editor: EditorState) => {
    const lsp = props.lsp?.();
    const changes = lspChanges;
    if (lsp === undefined || changes === null || editor.file === null) return;
    Option.match(languageForPath(lsp.catalog, editor.file), {
      onNone: () => undefined,
      onSome: (language) => {
        runSync(
          publishBufferChange(changes, {
            uri: fileUri(editor.file!),
            language,
            text: textOf(editor.buffer),
            cursor: { line: editor.cursor.row, character: editor.cursor.col },
          }),
        );
      },
    });
  };

  const openLspSession = (file: string) => {
    const lsp = props.lsp?.();
    if (lsp === undefined) return;
    closeLspSession();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* PubSub.unbounded<DocumentSnapshot>();
        lspChanges = changes;
        const exit = yield* Effect.exit(
          attachEditorDocument({
            services: lsp,
            file,
            workspace: props.spaceDir,
            snapshot: () => ({
              lines: linesOf(snapshot().buffer),
              cursor: snapshot().cursor,
            }),
            changes,
            onDiagnostics: (batch) => setDiagnostics(batch),
          }),
        );
        if (Exit.isFailure(exit)) {
          const message = Cause.squash(exit.cause);
          setMessage(`LSP: ${message instanceof Error ? message.message : String(message)}`);
          return;
        }
        setLspClient(exit.value);
        if (Option.isNone(exit.value)) return;
        return yield* Effect.never;
      }),
    ).pipe(Effect.provide(BunServices.layer));
    const fiber = runFork(
      program.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (lspSessionFiber === fiber) lspSessionFiber = null;
          }),
        ),
      ),
    );
    lspSessionFiber = fiber;
  };

  const syncLsp = (prev: EditorState, next: EditorState): Effect.Effect<void> => {
    if (props.lsp?.() === undefined) return Effect.void;
    return Effect.sync(() => {
      if (next.file === null) {
        if (prev.file !== null) closeLspSession();
        return;
      }
      if (prev.file !== next.file) {
        openLspSession(next.file);
        return;
      }
      // Soft-get may flip absent→present after mount; attach once if idle.
      if (Option.isNone(lspClient()) && lspSessionFiber === null) {
        openLspSession(next.file);
        return;
      }
      // didChange is full-document today (plugin-lsp openDocument). Cursor
      // alone must not stringify+publish — hold j/k/w/b was paying that cost
      // on every keystroke, serial with the key drain. Hover/signature read
      // editor.cursor directly; LiveDocument.snapshot() still has the live
      // cursor when LSP asks.
      if (next.buffer !== prev.buffer) {
        publishLspChange(next);
      }
    });
  };

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
        yield* highlight.open(next.file, textOf(next.buffer));
        return;
      }
      if (next.buffer !== prev.buffer) {
        yield* highlight.update(next.file, textOf(next.buffer));
      }
    });
  };

  /** Load the structural grammar for the buffer's filetype on open so tag
   *  textobjects / surround stay sync on the keypress path. */
  const syncStructure = (prev: EditorState, next: EditorState): Effect.Effect<void> => {
    if (next.file === null) {
      if (prev.grammar !== null) {
        return store.update((s) => (s.grammar === null ? s : { ...s, grammar: null }));
      }
      return Effect.void;
    }
    if (next.file === prev.file && next.grammar !== null) return Effect.void;
    const filetype = pathToFiletype(next.file);
    if (filetype === undefined) {
      return store.update((s) =>
        s.file === next.file && s.grammar !== null ? { ...s, grammar: null } : s,
      );
    }
    const opened = next.file;
    return props.treeSitter.grammar(filetype).pipe(
      Effect.flatMap((grammar) => store.update((s) => (s.file === opened ? { ...s, grammar } : s))),
      Effect.catchTags({
        // No wasm for this filetype — tag ops stay no-ops; not an error.
        GrammarSourceMissing: () =>
          store.update((s) =>
            s.file === opened && s.grammar !== null ? { ...s, grammar: null } : s,
          ),
        GrammarDownloadFailed: (error) =>
          store.update((s) =>
            s.file !== opened
              ? s
              : {
                  ...s,
                  grammar: null,
                  message:
                    error.status === undefined
                      ? `grammar download failed: ${error.grammar}`
                      : `grammar download failed: ${error.grammar} (${error.status})`,
                },
          ),
        GrammarWasmLoadFailed: (error) =>
          store.update((s) =>
            s.file !== opened
              ? s
              : {
                  ...s,
                  grammar: null,
                  message: `grammar load failed: ${error.grammar}`,
                },
          ),
      }),
    );
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
      yield* syncStructure(prev, next);
      yield* syncLsp(prev, next);
    });

  // Pre-fork buffer: keystrokes that arrive before the program has
  // published its queue land here, and the handler drains them once the
  // queue is live.
  type EditorInput = { readonly event: EditorEvent; readonly count?: number };
  const preBuffer: EditorInput[] = [];

  const keysDeferred = Deferred.makeUnsafe<Queue.Queue<EditorInput>>();

  const shellOf = (phaseRef: Ref.Ref<Phase>): EditorShell => ({
    props,
    io,
    store,
    phaseRef,
    updateAndSync,
    forgetFile,
    reduce,
  });

  const program = Effect.scoped(
    Effect.gen(function* () {
      const phaseRef = yield* Ref.make<Phase>(Phase.cases.Ready.make({}));
      const keys = yield* Queue.unbounded<EditorInput>();
      yield* Deferred.succeed(keysDeferred, keys);

      type SyncJob = {
        readonly file: string;
        readonly generation: number;
        readonly text: string;
      };
      const syncOffers = yield* Queue.sliding<SyncJob>(1);
      const pendingFlush = yield* Ref.make(false);
      const session = props.session;

      const offerStoreSync = (prev: EditorState, next: EditorState) => {
        if (
          session === undefined ||
          next.file === null ||
          next.generation === null ||
          next.buffer === prev.buffer
        ) {
          return Effect.void;
        }
        return Effect.gen(function* () {
          yield* Ref.set(pendingFlush, true);
          yield* Queue.offer(syncOffers, {
            file: next.file!,
            generation: next.generation!,
            text: `${textOf(next.buffer)}\n`,
          });
        });
      };

      if (session !== undefined) {
        yield* Effect.forkScoped(
          Stream.fromQueue(syncOffers).pipe(
            Stream.debounce("16 millis"),
            Stream.runForEach((job) =>
              replaceDocument(session, job.file, job.text, job.generation).pipe(
                Effect.flatMap((meta) =>
                  updateAndSync((s) =>
                    s.file === job.file ? { ...s, generation: meta.generation } : s,
                  ),
                ),
                Effect.ignore,
                Effect.ensuring(Ref.set(pendingFlush, false)),
              ),
            ),
          ),
        );

        yield* Effect.forkScoped(
          Effect.gen(function* () {
            const watches = yield* documentWatch(session);
            yield* watches.pipe(
              Stream.runForEach((snap) =>
                Effect.gen(function* () {
                  const state = yield* store.get;
                  if (state.file === null || state.generation === null) return;
                  if (fileUriFromPath(state.file) !== snap.uri) return;
                  if (snap.generation <= state.generation) return;
                  if (yield* Ref.get(pendingFlush)) return;
                  const split = snap.text.split("\n");
                  const lines = split.at(-1) === "" ? split.slice(0, -1) : split;
                  yield* updateAndSync((s) =>
                    reduce(s, {
                      _tag: "remote",
                      lines,
                      generation: snap.generation,
                      dirty: snap.dirty,
                    }),
                  );
                }),
              ),
            );
          }).pipe(Effect.ignore),
        );
      }

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const input = yield* Queue.take(keys);
            if ((yield* Ref.get(phaseRef))._tag === "Closed") return;
            const current = yield* store.get;
            const counted =
              input.count === undefined ? current : { ...current, count: String(input.count) };
            const next = reduce(counted, input.event);
            yield* updateAndSync(() => next);
            yield* offerStoreSync(current, next);
            const request = next.request;
            if (request === null) return;
            if (request._tag === "close") {
              yield* Ref.set(phaseRef, Phase.cases.Closed.make({}));
              yield* forgetFile();
              props.run(command("pane.close", { pane: props.paneId }));
              return;
            }
            if (request._tag === "invoke") {
              props.editor?.command.invoke(request.name, {
                bang: request.bang,
                arg: request.arg,
                state: next,
              });
              yield* updateAndSync((s) => ({ ...s, request: null }));
              return;
            }
            if (request._tag === "clipboard") {
              props.copyText(request.text, request.target);
              yield* updateAndSync((s) => ({ ...s, request: null }));
              return;
            }
            if (request._tag === "read") {
              yield* Ref.set(phaseRef, Phase.cases.Io.make({}));
              yield* dispatchRead(shellOf(phaseRef), request.path, request.afterRow);
              return;
            }
            if (request._tag === "shell-read") {
              yield* Ref.set(phaseRef, Phase.cases.Io.make({}));
              yield* dispatchShellRead(shellOf(phaseRef), request.cmd, request.afterRow);
              return;
            }
            yield* Ref.set(phaseRef, Phase.cases.Io.make({}));
            yield* fulfill(shellOf(phaseRef), next, request);
          }),
        ),
      );

      // The descriptor's file is opened on mount. Validation is at the
      // boundary, not behind a chain of `typeof` guards.
      const descriptor = S.decodeOption(S.fromJsonString(EditorDescriptorOrNull))(props.descriptor);
      if (descriptor._tag === "Some" && descriptor.value !== null) {
        yield* dispatchOpen(shellOf(phaseRef), descriptor.value.file, false);
      }

      return yield* Effect.never;
    }),
  );

  const programFiber = runFork(program.pipe(Effect.provide(Path.layer)));

  const unsubscribeHighlight = props.highlight?.subscribe((_file, _version, next) => {
    if (_file === currentFile) setChunks(next);
  });

  const enqueueEvent = (event: EditorEvent, count?: number) => {
    const live = runSync(
      Deferred.poll(keysDeferred).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<Queue.Queue<EditorInput>>()),
            onSome: (ready) => ready.pipe(Effect.map(Option.some)),
          }),
        ),
      ),
    );
    Option.match(live, {
      onNone: () => {
        preBuffer.push({ event, count });
      },
      onSome: (queue) => {
        for (const buffered of preBuffer.splice(0)) Queue.offerUnsafe(queue, buffered);
        Queue.offerUnsafe(queue, { event, count });
      },
    });
  };
  const enqueue = (key: KeyEvent, count?: number) => {
    setHover(null);
    enqueueEvent({ _tag: "key", key }, count);
  };
  const scrollBy = (delta: number) => {
    setHover(null);
    enqueueEvent({ _tag: "scroll", delta });
  };
  const chooseCompletion = () => {
    const item = commandItems()[selectedCompletion()];
    if (item) enqueueEvent({ _tag: "command-complete", command: item.replacement });
  };

  const setMessage = (message: string) => setSnapshot((state) => ({ ...state, message }));

  const withClient = (body: (client: LspDocumentClient, editor: EditorState) => void): void => {
    const editor = snapshot();
    if (editor.file === null) {
      setMessage("no file");
      return;
    }
    if (props.lsp?.() === undefined) {
      setMessage("amux.lsp plugin required");
      return;
    }
    Option.match(lspClient(), {
      onNone: () => {
        // Services arrived after the initial open — attach and ask for a retry.
        openLspSession(editor.file!);
        setMessage("LSP not ready");
      },
      onSome: (client) => body(client, editor),
    });
  };

  const gotoLocation = (location: LspLocation) => {
    Option.match(pathFromUri(location.uri), {
      onNone: () => setMessage(`cannot open ${location.uri}`),
      onSome: (path) =>
        enqueueEvent({
          _tag: "goto",
          path,
          row: location.range.start.line,
          col: location.range.start.character,
        }),
    });
  };

  const resolveLocations = (
    title: string,
    locations: readonly LspLocation[],
    emptyMessage: string,
  ) => {
    if (locations.length === 0) {
      setMessage(emptyMessage);
      return;
    }
    if (locations.length === 1) {
      gotoLocation(locations[0]!);
      return;
    }
    const ui = props.lspUi;
    if (ui === undefined) {
      setMessage(`${locations.length} ${title} (no picker)`);
      return;
    }
    const editor = snapshot();
    const previewBuffer =
      editor.file === null
        ? undefined
        : { uri: fileUri(editor.file), lines: linesOf(editor.buffer) };
    ui.pickLocations(title, locations, Option.some(props.spaceDir), gotoLocation, previewBuffer);
  };

  const applyRename = (edit: import("@danielfgray/amux-plugin-lsp").LspWorkspaceEdit) => {
    const editor = snapshot();
    if (editor.file === null) return;
    const uri = fileUri(editor.file);
    const byUri = editsByUri(edit);
    const mine = byUri.get(uri) ?? [];
    const others = [...byUri.keys()].filter((key) => key !== uri).length;
    Option.match(applyBufferEdits(editor, mine), {
      onNone: () => setMessage("rename failed"),
      onSome: (next) => {
        runFork(
          updateAndSync(() => {
            const suffix =
              others > 0 ? ` (${others} other file${others === 1 ? "" : "s"} not applied)` : "";
            return {
              ...next,
              message: mine.length === 0 ? `no edits for this buffer${suffix}` : `renamed${suffix}`,
            };
          }),
        );
      },
    });
  };

  /** Cite: nvim Client:exec_cmd — client command or workspace/executeCommand. */
  const runLspCommand = (client: LspDocumentClient, command: LspCommand) => {
    if (
      command.command === "editor.action.showReferences" ||
      command.command.endsWith(".showReferences")
    ) {
      Option.match(decodeShowReferencesArgs(command.arguments), {
        onNone: () => setMessage("showReferences: invalid arguments"),
        onSome: (locations) => resolveLocations("references", locations, "no references"),
      });
      return;
    }
    if (command.command.startsWith("editor.")) {
      setMessage(`unknown client command: ${command.command}`);
      return;
    }
    runFork(
      client.executeCommand(command).pipe(
        Effect.map(() => setMessage(command.title)),
        Effect.catch(() => Effect.sync(() => setMessage(`command failed: ${command.command}`))),
      ),
    );
  };

  /**
   * Cite: neovim buf.lua `apply_action` — edit first, then command.
   */
  const applyCodeActionItem = (client: LspDocumentClient, action: LspCodeActionItem) => {
    if (isLspCommand(action)) {
      runLspCommand(client, action);
      return;
    }
    if (action.disabled !== undefined) {
      setMessage(action.disabled.reason);
      return;
    }
    if (action.edit !== undefined) applyRename(action.edit);
    if (action.command !== undefined) runLspCommand(client, action.command);
    else if (action.edit === undefined)
      setMessage(`code action has no edit or command: ${action.title}`);
    else setMessage(action.title);
  };

  /**
   * Cite: neovim buf.lua `on_user_choice` — resolve when incomplete, then apply.
   * `not (edit and command)` → try codeAction/resolve; on failure apply original if any.
   */
  const chooseCodeAction = (client: LspDocumentClient, action: LspCodeActionItem) => {
    if (isLspCommand(action)) {
      applyCodeActionItem(client, action);
      return;
    }
    if (action.disabled !== undefined) {
      setMessage(action.disabled.reason);
      return;
    }
    const complete = action.edit !== undefined && action.command !== undefined;
    if (complete) {
      applyCodeActionItem(client, action);
      return;
    }
    runFork(
      client.resolveCodeAction(action).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.sync(() => applyCodeActionItem(client, action)),
            onSome: (resolved) => Effect.sync(() => applyCodeActionItem(client, resolved)),
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            if (action.edit !== undefined || action.command !== undefined) {
              applyCodeActionItem(client, action);
            } else {
              setMessage(`code action resolve failed: ${action.title}`);
            }
          }),
        ),
      ),
    );
  };

  const codeActionPreview = (
    action: LspCodeActionItem,
    uri: string,
    lines: readonly string[],
    pathLabel: string,
  ): string => {
    if (isLspCommand(action)) {
      if (
        action.command === "editor.action.showReferences" ||
        action.command.endsWith(".showReferences")
      ) {
        return Option.match(decodeShowReferencesArgs(action.arguments), {
          onNone: () => `${action.title}\n${action.command}`,
          onSome: (locations) =>
            `${action.title}\n${locations.length} location${locations.length === 1 ? "" : "s"}`,
        });
      }
      return `${action.title}\n${action.command}`;
    }
    if (action.edit !== undefined) {
      return workspaceEditPreview(uri, lines, action.edit, pathLabel);
    }
    if (action.command !== undefined) {
      return `${action.title}\n${action.command.command}`;
    }
    return action.disabled !== undefined
      ? `${action.title} (disabled)\n${action.disabled.reason}`
      : `${action.title}\n(unresolved — will resolve on pick)`;
  };

  const runCodeLens = (client: LspDocumentClient, lens: LspCodeLens) => {
    const ensure = Option.match(Option.fromNullishOr(lens.command), {
      onSome: (command) => Effect.succeed(Option.some(command)),
      onNone: () =>
        client
          .resolveCodeLens(lens)
          .pipe(
            Effect.map((resolved) =>
              Option.flatMap(resolved, (next) => Option.fromNullishOr(next.command)),
            ),
          ),
    });
    runFork(
      ensure.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.sync(() => setMessage("code lens has no command")),
            onSome: (command) => Effect.sync(() => runLspCommand(client, command)),
          }),
        ),
        Effect.catch(() => Effect.sync(() => setMessage("code lens unavailable"))),
      ),
    );
  };

  const controller: EditorController = {
    active: props.active,
    state: snapshot,
    dispatch: enqueue,
    completionVisible,
    moveCompletion: (delta) =>
      setSelectedCompletion((current) =>
        Math.max(0, Math.min(commandItems().length - 1, current + delta)),
      ),
    chooseCompletion,
    requestFileCompletion: () => {
      const line = snapshot().command;
      const fileArg = fileArgCompletion(line, registeredCommands());
      if (fileArg === null) return false;
      setFileArmed(true);
      loadFileCompletion(fileArg.head, fileArg.prefix);
      return true;
    },
    openPath: (path) =>
      enqueueEvent({
        _tag: "goto",
        path,
        row: 0,
        col: 0,
      }),
    apply: (f) => {
      runFork(updateAndSync(f));
    },
    hoverVisible: () => hover() !== null,
    dismissHover: () => setHover(null),
    requestHover: () => {
      withClient((client, editor) => {
        runFork(
          client.hover({ line: editor.cursor.row, character: editor.cursor.col }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.sync(() => {
                    setHover(null);
                    setMessage("no hover information");
                  }),
                onSome: (result) =>
                  Effect.sync(() => {
                    const text = hoverText(result.contents).trim();
                    if (text.length === 0) {
                      setHover(null);
                      setMessage("no hover information");
                      return;
                    }
                    const lines = hoverLines(text);
                    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
                    const contentLines = splitHoverSegments(text).reduce(
                      (count, segment) =>
                        count +
                        (segment.kind === "code"
                          ? Math.max(1, segment.code.split("\n").length)
                          : segment.text.split("\n").length),
                      0,
                    );
                    const gutter = editor.options.number ? HOVER_GUTTER_WIDTH : 0;
                    const place = placeHoverPopup({
                      cursorRow: editor.cursor.row,
                      cursorCol: editor.cursor.col,
                      viewportTop: editor.viewport.top,
                      paneWidth: props.width(),
                      paneHeight: props.height(),
                      gutter,
                      contentLines: Math.max(lines.length, contentLines),
                      // Grow toward the type signature, but stay inside the pane.
                      preferredWidth: Math.min(Math.max(40, longest + 4), 80),
                    });
                    setSnapshot((state) => ({ ...state, message: null }));
                    setHover({ text, lines, place });
                  }),
              }),
            ),
            Effect.catch(() =>
              Effect.sync(() => {
                setHover(null);
                setMessage("hover unavailable");
              }),
            ),
          ),
        );
      });
    },
    requestCompletion: () => {
      withClient((client, editor) => {
        runFork(
          client.completion({ line: editor.cursor.row, character: editor.cursor.col }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.sync(() => setMessage("no completions")),
                onSome: (result) => {
                  const labels = completionLabels(result);
                  const preview = labels.slice(0, 8).join(", ");
                  const suffix = labels.length > 8 ? ` (+${labels.length - 8} more)` : "";
                  return Effect.sync(() =>
                    setMessage(labels.length > 0 ? preview + suffix : "no completions"),
                  );
                },
              }),
            ),
            Effect.catch(() => Effect.sync(() => setMessage("completion unavailable"))),
          ),
        );
      });
    },
    requestDefinition: () => {
      withClient((client, editor) => {
        runFork(
          client.definition({ line: editor.cursor.row, character: editor.cursor.col }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.sync(() => setMessage("no definition")),
                onSome: (value) =>
                  Effect.sync(() =>
                    resolveLocations("definitions", asLocations(value), "no definition"),
                  ),
              }),
            ),
            Effect.catch(() => Effect.sync(() => setMessage("definition unavailable"))),
          ),
        );
      });
    },
    requestDeclaration: () => {
      withClient((client, editor) => {
        const pos = { line: editor.cursor.row, character: editor.cursor.col };
        runFork(
          client.declaration(pos).pipe(
            Effect.flatMap(
              Option.match({
                // Many servers omit declaration — fall back like neovim's note suggests.
                onNone: () =>
                  client.definition(pos).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.sync(() => setMessage("no declaration")),
                        onSome: (value) =>
                          Effect.sync(() =>
                            resolveLocations("declarations", asLocations(value), "no declaration"),
                          ),
                      }),
                    ),
                  ),
                onSome: (value) =>
                  Effect.sync(() =>
                    resolveLocations("declarations", asLocations(value), "no declaration"),
                  ),
              }),
            ),
            Effect.catch(() => Effect.sync(() => setMessage("declaration unavailable"))),
          ),
        );
      });
    },
    requestTypeDefinition: () => {
      withClient((client, editor) => {
        runFork(
          client.typeDefinition({ line: editor.cursor.row, character: editor.cursor.col }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.sync(() => setMessage("no type definition")),
                onSome: (value) =>
                  Effect.sync(() =>
                    resolveLocations("type definitions", asLocations(value), "no type definition"),
                  ),
              }),
            ),
            Effect.catch(() => Effect.sync(() => setMessage("type definition unavailable"))),
          ),
        );
      });
    },
    requestImplementation: () => {
      withClient((client, editor) => {
        runFork(
          client.implementation({ line: editor.cursor.row, character: editor.cursor.col }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.sync(() => setMessage("no implementation")),
                onSome: (value) =>
                  Effect.sync(() =>
                    resolveLocations("implementations", asLocations(value), "no implementation"),
                  ),
              }),
            ),
            Effect.catch(() => Effect.sync(() => setMessage("implementation unavailable"))),
          ),
        );
      });
    },
    requestReferences: () => {
      withClient((client, editor) => {
        runFork(
          client.references({ line: editor.cursor.row, character: editor.cursor.col }).pipe(
            Effect.map((refs) => resolveLocations("references", refs, "no references")),
            Effect.catch(() => Effect.sync(() => setMessage("references unavailable"))),
          ),
        );
      });
    },
    requestDocumentSymbols: () => {
      withClient((client, editor) => {
        if (editor.file === null) return;
        const uri = fileUri(editor.file);
        runFork(
          client.symbols.pipe(
            Effect.map((syms) =>
              resolveLocations(
                "document symbols",
                flattenDocumentSymbols(uri, syms),
                "no document symbols",
              ),
            ),
            Effect.catch(() => Effect.sync(() => setMessage("document symbols unavailable"))),
          ),
        );
      });
    },
    requestCodeAction: () => {
      withClient((client, editor) => {
        const pos = { line: editor.cursor.row, character: editor.cursor.col };
        const range = { start: pos, end: pos };
        const ui = props.lspUi;
        // Cite: neovim buf.code_action — pass diagnostics covering the cursor.
        const cursorDiags = Option.match(diagnosticAtCursor(diagnostics(), editor.cursor), {
          onNone: () => [] as const,
          onSome: (d) => [d] as const,
        });
        runFork(
          client.codeAction(range, { diagnostics: cursorDiags }).pipe(
            Effect.map((actions) => {
              if (actions.length === 0) {
                setMessage("No code actions available");
                return;
              }
              // Cite: neovim always vim.ui.select unless opts.apply (gra does not set apply).
              if (ui === undefined) {
                setMessage(`${actions.length} code actions (no picker)`);
                return;
              }
              const uri = editor.file === null ? "" : fileUri(editor.file);
              const lines = linesOf(editor.buffer);
              const pathLabel = editor.file ?? "buffer";
              const byId = new Map<string, LspCodeActionItem>(
                actions.map((action, index) => [`${index}`, action]),
              );
              ui.pickWithPreview(
                "Code actions:",
                actions.map((action, index) => ({
                  id: `${index}`,
                  label: isLspCommand(action)
                    ? action.title
                    : action.disabled !== undefined
                      ? `${action.title} (disabled)`
                      : action.title,
                  detail: isLspCommand(action) ? undefined : action.kind,
                })),
                (item) => {
                  const action = byId.get(item.id);
                  return action === undefined
                    ? undefined
                    : codeActionPreview(action, uri, lines, pathLabel);
                },
                (item) => {
                  const action = byId.get(item.id);
                  if (action !== undefined) chooseCodeAction(client, action);
                },
                { previewTitle: " preview " },
              );
            }),
            Effect.catch(() => Effect.sync(() => setMessage("code action unavailable"))),
          ),
        );
      });
    },
    requestCodeLens: () => {
      withClient((client, editor) => {
        const ui = props.lspUi;
        runFork(
          client.codeLenses.pipe(
            Effect.map((lenses) => {
              const onLine = lenses.filter((lens) => lens.range.start.line === editor.cursor.row);
              if (onLine.length === 0) {
                setMessage("no code lens on this line");
                return;
              }
              // Light status strip — full virt-line gutter is deferred.
              const titles = onLine
                .map((lens) => lens.command?.title ?? "(unresolved)")
                .join(" · ");
              setMessage(titles);
              if (onLine.length === 1 || ui === undefined) {
                runCodeLens(client, onLine[0]!);
                return;
              }
              const byId = new Map<string, LspCodeLens>(
                onLine.map((lens, index) => [`${index}`, lens]),
              );
              const previewUri = editor.file === null ? undefined : fileUri(editor.file);
              const previewLines = linesOf(editor.buffer);
              ui.pickWithPreview(
                "code lenses",
                onLine.map((lens, index) => ({
                  id: `${index}`,
                  label: lens.command?.title ?? "resolve…",
                  detail: lens.command?.command,
                })),
                (item) => {
                  const lens = byId.get(item.id);
                  const command = lens?.command;
                  if (command === undefined) return "(unresolved — will resolve on pick)";
                  if (
                    command.command === "editor.action.showReferences" ||
                    command.command.endsWith(".showReferences")
                  ) {
                    return Option.match(decodeShowReferencesArgs(command.arguments), {
                      onNone: () => `${command.title}\n(invalid showReferences args)`,
                      onSome: (locations) => {
                        const header = `${command.title}\n${locations.length} location${locations.length === 1 ? "" : "s"}`;
                        const first = locations[0];
                        if (first === undefined || previewUri === undefined) return header;
                        return `${header}\n\n${locationSnippetPreview(first, {
                          currentUri: previewUri,
                          lines: previewLines,
                          workspace: Option.some(props.spaceDir),
                        })}`;
                      },
                    });
                  }
                  return `${command.title}\n${command.command}`;
                },
                (item) => {
                  const lens = byId.get(item.id);
                  if (lens !== undefined) runCodeLens(client, lens);
                },
                { previewTitle: " lens " },
              );
            }),
            Effect.catch(() => Effect.sync(() => setMessage("code lens unavailable"))),
          ),
        );
      });
    },
    requestSignatureHelp: () => {
      withClient((client, editor) => {
        runFork(
          client.signatureHelp({ line: editor.cursor.row, character: editor.cursor.col }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.sync(() => setMessage("no signature help")),
                onSome: (help) =>
                  Effect.sync(() => {
                    const text = signatureHelpText(help).trim();
                    if (text.length === 0) {
                      setMessage("no signature help");
                      return;
                    }
                    const lines = hoverLines(text);
                    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
                    const gutter = editor.options.number ? HOVER_GUTTER_WIDTH : 0;
                    const place = placeHoverPopup({
                      cursorRow: editor.cursor.row,
                      cursorCol: editor.cursor.col,
                      viewportTop: editor.viewport.top,
                      paneWidth: props.width(),
                      paneHeight: props.height(),
                      gutter,
                      contentLines: lines.length,
                      preferredWidth: Math.min(Math.max(40, longest + 4), 80),
                    });
                    setSnapshot((state) => ({ ...state, message: null }));
                    setHover({ text, lines, place });
                  }),
              }),
            ),
            Effect.catch(() => Effect.sync(() => setMessage("signature help unavailable"))),
          ),
        );
      });
    },
    jumpDiagnostic: (kind) => {
      const editor = snapshot();
      Option.match(findDiagnosticJump(diagnostics(), editor.cursor, kind, 1), {
        onNone: () => setMessage("no diagnostics"),
        onSome: (pos) => {
          const same = pos.row === editor.cursor.row && pos.col === editor.cursor.col;
          runFork(
            updateAndSync(() => ({
              ...editor,
              cursor: pos,
              jumpList: same ? editor.jumpList : pushJump(editor.jumpList, editor.cursor),
              message: null,
            })),
          );
        },
      });
    },
    showDiagnosticFloat: () => {
      const editor = snapshot();
      Option.match(diagnosticAtCursor(diagnostics(), editor.cursor), {
        onNone: () => setMessage("no diagnostic under cursor"),
        onSome: (d) => setMessage(formatDiagnostic(d)),
      });
    },
    requestRename: () => {
      withClient((client, editor) => {
        const ui = props.lspUi;
        const initial = Option.getOrElse(wordAtCursor(editor), () => "");
        const run = (newName: string) => {
          runFork(
            client.rename({ line: editor.cursor.row, character: editor.cursor.col }, newName).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.sync(() => setMessage("no rename edits")),
                  onSome: (edit) => Effect.sync(() => applyRename(edit)),
                }),
              ),
              Effect.catch(() => Effect.sync(() => setMessage("rename unavailable"))),
            ),
          );
        };
        if (ui === undefined) {
          setMessage("rename needs the overlay picker");
          return;
        }
        ui.promptRename(initial, run);
      });
    },
  };
  const unregister = props.registerController?.(props.paneId, controller);

  // Insert text has no finite binding table. It remains at the bottom of the
  // input chain; normal-mode keys are claimed by the plugin's contexts.
  // Insert and search have unbounded character input (no finite binding
  // table). Search also has `editor.search` as a context handle — this
  // capture is the fallback if that context is inactive for a tick.
  props.captureKeys((key) => {
    if (key === null) return false;
    const mode = snapshot().mode;
    if (mode !== "insert" && mode !== "search") return false;
    enqueue(key);
    return true;
  });

  onCleanup(() => {
    runFork(Fiber.interrupt(programFiber));
    unsubscribeHighlight?.();
    closeLspSession();
    // The drainer is gone, so close the tree-sitter buffer directly: the
    // provider never fails, and an orphan buffer would highlight nothing.
    if (currentFile !== null && props.highlight !== undefined) {
      const file = currentFile;
      currentFile = null;
      runFork(props.highlight.close(file));
    }
    unregister?.();
  });

  return {
    state: snapshot,
    chunks,
    diagnostics,
    diagnosticLines,
    commandItems,
    selectedCompletion,
    setSelectedCompletion,
    completionVisible,
    chooseCompletion,
    scrollBy,
    hover,
  };
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
  readonly reduce: (state: EditorState, event: EditorEvent) => EditorState;
}
/** Fulfill an `open` request: read the file, push the `loaded` event, then
 *  record the file in the pane descriptor if `recordDescriptor`. Optional
 *  cursor lands after load (LSP goto). */
const dispatchOpen = (
  shell: EditorShell,
  file: string,
  recordDescriptor: boolean,
  cursor: Option.Option<{ readonly row: number; readonly col: number }> = Option.none(),
) =>
  Effect.gen(function* () {
    const { props, io, phaseRef, updateAndSync, reduce } = shell;
    yield* Ref.set(phaseRef, Phase.cases.Io.make({}));
    const exit = yield* Effect.exit(io.read(file, props.spaceDir));
    if (Exit.isSuccess(exit)) {
      const result: EditorReadResult = exit.value;
      yield* updateAndSync((s) => {
        const loaded = reduce(s, {
          _tag: "loaded",
          file: result.file,
          lines: result.lines,
          generation: result.generation,
        });
        return Option.match(cursor, {
          onNone: () => loaded,
          onSome: (at) => ({
            ...loaded,
            cursor: {
              row: Math.min(at.row, Math.max(0, rowCount(loaded.buffer) - 1)),
              col: at.col,
            },
          }),
        });
      });
      if (recordDescriptor) {
        const descriptor = yield* S.encodeEffect(S.fromJsonString(EditorDescriptor))({
          file: result.file,
        });
        props.run(
          command("pane.set-descriptor", {
            pane: props.paneId,
            descriptor,
          }),
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

/** `:r path` — insert file lines after `afterRow` without replacing the buffer. */
const dispatchRead = (shell: EditorShell, file: string, afterRow: number) =>
  Effect.gen(function* () {
    const { props, io, phaseRef, updateAndSync } = shell;
    const exit = yield* Effect.exit(io.read(file, props.spaceDir));
    if (Exit.isSuccess(exit)) {
      const result: EditorReadResult = exit.value;
      const insert = result.lines.length > 0 ? result.lines : [""];
      const at = afterRow + 1;
      yield* updateAndSync((s) => {
        const cleared = { ...s, request: null };
        const started = startChange(cleared, [":", "r"]);
        const next = editReplaceLines(started, at, at, insert);
        return finishChange({
          ...next,
          cursor: { row: at, col: 0 },
          message: `${insert.length} more line${insert.length === 1 ? "" : "s"}`,
        });
      });
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

/** `:r!{cmd}` — insert shell stdout after `afterRow` (`0` → top of buffer). */
const dispatchShellRead = (shell: EditorShell, cmd: string, afterRow: number) =>
  Effect.gen(function* () {
    const { props, io, phaseRef, updateAndSync } = shell;
    const exit = yield* Effect.exit(io.shell(cmd, props.spaceDir));
    if (Exit.isSuccess(exit)) {
      const result = exit.value;
      const insert = result.lines.length > 0 ? result.lines : [""];
      const at = Math.max(0, afterRow + 1);
      const status =
        result.exitCode === 0
          ? `${insert.length} more line${insert.length === 1 ? "" : "s"}`
          : `shell returned ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}`;
      yield* updateAndSync((s) => {
        const cleared = { ...s, request: null };
        const started = startChange(cleared, [":", "r!"]);
        const next = editReplaceLines(started, at, at, insert);
        return finishChange({
          ...next,
          cursor: { row: at, col: 0 },
          message: status,
        });
      });
    } else {
      const message = Cause.squash(exit.cause);
      yield* updateAndSync((s) => ({
        ...s,
        request: null,
        message: `shell failed: ${message instanceof Error ? message.message : String(message)}`,
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
    const { props, io, phaseRef, updateAndSync, forgetFile, reduce } = shell;
    if (request._tag === "open") {
      const cursor =
        request.row !== undefined
          ? Option.some({ row: request.row, col: request.col ?? 0 })
          : Option.none();
      yield* dispatchOpen(shell, request.path, true, cursor);
      return;
    }
    if (state.file === null) {
      yield* updateAndSync((s) =>
        reduce(s, { _tag: "write-error", message: "no file name (open one with :e path)" }),
      );
      yield* Ref.set(phaseRef, Phase.cases.Ready.make({}));
      return;
    }
    const exit = yield* Effect.exit(io.write(state.file, linesOf(state.buffer), props.spaceDir));
    if (Exit.isSuccess(exit)) {
      yield* updateAndSync((s) => reduce(s, { _tag: "written" }));
      if (request._tag === "write-close") {
        yield* Ref.set(phaseRef, Phase.cases.Closed.make({}));
        yield* forgetFile();
        props.run(command("pane.close", { pane: props.paneId }));
      }
    } else {
      const message = Cause.squash(exit.cause);
      yield* updateAndSync((s) =>
        reduce(s, {
          _tag: "write-error",
          message: message instanceof Error ? message.message : String(message),
        }),
      );
    }
    yield* Ref.set(phaseRef, Phase.cases.Ready.make({}));
  });

type SelectionView = {
  readonly from: { readonly row: number; readonly col: number };
  readonly to: { readonly row: number; readonly col: number };
  readonly linewise: boolean;
  /** False for CUA half-open ranges (`to` exclusive). */
  readonly inclusive: boolean;
};

type LinePart = {
  readonly text: string;
  readonly fg?: TextChunk["fg"];
  readonly selected: boolean;
};

function selectedParts(
  text: string,
  fg: TextChunk["fg"],
  selected: (col: number) => boolean,
): LinePart[] {
  if (text.length === 0) return [];
  const parts: LinePart[] = [];
  let start = 0;
  let current = selected(0);
  for (let col = 1; col < text.length; col += 1) {
    const next = selected(col);
    if (next !== current) {
      parts.push({ text: text.slice(start, col), fg, selected: current });
      start = col;
      current = next;
    }
  }
  parts.push({ text: text.slice(start), fg, selected: current });
  return parts;
}

function LineRow(props: {
  text: string;
  number: number | null;
  diagnostic: boolean;
  cursor: number;
  row: number;
  selection: SelectionView | null;
  chunks?: readonly TextChunk[];
}) {
  const selected = (col: number) => {
    const range = props.selection;
    if (range === null || props.row < range.from.row || props.row > range.to.row) return false;
    if (range.linewise || (range.from.row < props.row && props.row < range.to.row)) return true;
    const endOk = (c: number) => (range.inclusive ? c <= range.to.col : c < range.to.col);
    if (range.from.row === range.to.row) return col >= range.from.col && endOk(col);
    if (props.row === range.from.row) return col >= range.from.col;
    return endOk(col);
  };
  const parts = () => {
    if (props.chunks === undefined || props.chunks.length === 0) {
      return selectedParts(props.text, undefined, selected);
    }
    const result: LinePart[] = [];
    let offset = 0;
    for (const chunk of props.chunks) {
      for (const part of selectedParts(chunk.text, chunk.fg, (col) => selected(offset + col))) {
        result.push(part);
      }
      offset += chunk.text.length;
    }
    return result;
  };
  const gutter = () => (props.diagnostic ? "!" : props.number);
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <Show when={props.number !== null || props.diagnostic}>
        <text
          style={{
            width: 4,
            flexShrink: 0,
            fg: props.diagnostic ? theme.red : theme.overlay1,
          }}
        >
          {gutter()}
        </text>
      </Show>
      <For each={parts()}>
        {(part) => (
          <text
            style={{
              flexShrink: 0,
              fg: part.selected ? theme.base : (part.fg ?? theme.text),
              bg: part.selected ? theme.blue : undefined,
            }}
          >
            {part.text}
          </text>
        )}
      </For>
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
