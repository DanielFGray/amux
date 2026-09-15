/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js";
import { Context, Effect, Layer, Option } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { KeyEvent } from "@opentui/core";
import { definePlugin, PluginActivateError, type PluginDefinition } from "@danielfgray/amux";
import { openDocument, writeDocument } from "@danielfgray/amux/document-client.ts";
import { optionalEnvVar } from "@danielfgray/amux/session.ts";
import {
  BindingsTag,
  CONTEXT_PRIORITY,
  ContextsTag,
  createCountAccumulator,
  KeyInvocation,
  OptionsTag,
  PanelTag,
  paneRealm,
  Realm,
  SessionViewsTag,
  SettingsTag,
  SlotsTag,
  theme,
} from "@danielfgray/amux";
import { contextCommand, type ContextSpec, type PanelContext } from "@danielfgray/amux";
import type { OptionSpec } from "@danielfgray/amux";
import { editorOpenCommand } from "./command-args.ts";
import { EditorControllerTag, EditorPane, type EditorController } from "./EditorPane.tsx";
import { EditorIo, listEntriesWith, runShellCommand, type EditorIoService } from "./io.ts";
import { BUILTIN_MAPS, type BuiltinMapId, type MapScope } from "./maps.ts";
import {
  applySurround,
  beginSearch,
  beginSubstitute,
  beginSurround,
  runBuiltinMap,
} from "./vim-core.ts";
import { showcmdStrokes } from "./showcmd.ts";
import { registerLspUi, type LspUi } from "./lsp-ui.tsx";
import { registerFileUi, type FileUi } from "./file-ui.tsx";
import { SearchService } from "@danielfgray/amux-plugin-search";

/**
 * Command-mode keys claimed by the completion overlay.
 *
 * Returns `null` when the picker is hidden (caller should fall through).
 * Enter expands the selection, then dispatches so a runnable line (`:q`)
 * actually executes — the overlay must not swallow the key.
 * Tab past `:e `'s first space arms the file picker (SearchService / dir list).
 */
export function handleCommandPickerKey(
  controller: Pick<
    EditorController,
    "completionVisible" | "moveCompletion" | "chooseCompletion" | "requestFileCompletion"
  >,
  event: KeyEvent,
  dispatch: (event: KeyEvent) => boolean,
): boolean | null {
  if (event.name === "tab" && controller.requestFileCompletion()) return true;
  if (!controller.completionVisible()) return null;
  if (event.name === "down") {
    controller.moveCompletion(1);
    return true;
  }
  if (event.name === "up") {
    controller.moveCompletion(-1);
    return true;
  }
  if (event.name === "return" || event.name === "enter") {
    controller.chooseCompletion();
    return dispatch(event);
  }
  return null;
}
import {
  discoverCachedParsers,
  HighlightProvider,
  makeHighlightProvider,
  TreeSitter,
  treeSitterLayer,
} from "@danielfgray/amux-highlight";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { builtInCatalog, DocumentService, LspService } from "@danielfgray/amux-plugin-lsp";
import type { EditorLspServices } from "./lsp-bridge.ts";
import { createEditor, Editor } from "./api.ts";

export const EDITOR_PLUGIN_ID = "amux.editor";

export const EDITOR_SETTINGS = {
  "editor.number": { kind: "boolean", default: true, desc: "show line numbers" },
  "editor.keyProfile": {
    kind: "enum",
    default: "vim",
    values: ["vim", "cua"],
    desc: "key profile · vim modal or CUA/modeless",
  },
} as const satisfies Record<string, OptionSpec>;

type EditorSettingName = keyof typeof EDITOR_SETTINGS;
const SETTING_NAMES = Object.keys(EDITOR_SETTINGS) as EditorSettingName[];

function settingValue<N extends EditorSettingName>(
  panel: PanelContext,
  name: N,
): (typeof EDITOR_SETTINGS)[N]["default"] {
  const spec = EDITOR_SETTINGS[name];
  const value = panel.options()[name];
  return (value === undefined ? spec.default : value) as (typeof EDITOR_SETTINGS)[N]["default"];
}

/** Cycle an enum setting; return true if the event was claimed. */
function cycleEnumSetting(panel: PanelContext, name: EditorSettingName, by: 1 | -1): void {
  const spec = EDITOR_SETTINGS[name];
  if (spec.kind !== "enum") return;
  const values = spec.values;
  const current = settingValue(panel, name);
  // settingValue is keyed by the full EditorSettingName union, so current may
  // still be boolean here; only string values participate in an enum cycle.
  if (typeof current !== "string") return;
  const index = values.findIndex((value) => value === current);
  const next = values[(Math.max(index, 0) + by + values.length) % values.length]!;
  panel.setOption(name, next);
  panel.saveOptions();
}

/**
 * Build the editor's live `EditorIo` against the platform filesystem and
 * path services. The `Effect.provide` keeps `FileSystem`/`Path` inside
 * this expression, so the plugin's outer effect context — the part the
 * host checks against `inject` — never names them.
 */
const buildEditorIo: Effect.Effect<EditorIoService> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const session = Option.getOrUndefined(yield* optionalEnvVar("AMUX_SESSION"));
  const shellBin = Option.getOrElse(yield* optionalEnvVar("SHELL"), () => "sh");
  return EditorIo.of({
    read: (file, spaceDir) =>
      Effect.gen(function* () {
        const resolved = path.resolve(spaceDir, file);
        const text = yield* fs.readFileString(resolved);
        const lines = text.split("\n");
        const normalized =
          lines.at(-1) === ""
            ? { file: resolved, lines: lines.slice(0, -1) }
            : { file: resolved, lines };
        // Register with the daemon store so agent writes see the open buffer.
        if (session !== undefined) {
          const meta = yield* openDocument(session, resolved, text).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none()),
          );
          return {
            ...normalized,
            generation: Option.getOrUndefined(meta)?.generation,
          };
        }
        return normalized;
      }),
    write: (file, lines, spaceDir) =>
      Effect.gen(function* () {
        const resolved = file.startsWith("/") ? file : path.resolve(spaceDir, file);
        const text = lines.join("\n") + "\n";
        if (session !== undefined) {
          yield* writeDocument(session, resolved, text).pipe(
            Effect.catch(() => fs.writeFileString(resolved, text)),
          );
          return;
        }
        yield* fs.writeFileString(resolved, text);
      }),
    resolve: (spaceDir, p) =>
      Effect.sync(() => (p.startsWith("/") ? p : path.resolve(spaceDir, p))),
    listEntries: listEntriesWith(fs, path),
    shell: (cmd, spaceDir) => runShellCommand(shellBin, cmd, spaceDir),
  });
}).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)));

/**
 * The vim editor as a plugin — the pane-side stress test of the plugin API.
 *
 * Everything a real editor needs is acquired here: the session view (renders
 * the buffer in a pane), the line-number setting, the filesystem service
 * (read a file, write one), and a binding that opens a scratch buffer.
 * Core supplies the pane seam — the daemon's `editor.open` command places a
 * sessionless pane, `captureKeys` hands it the unclaimed keys, and
 * `pane.set-descriptor` persists which file it shows — while this plugin
 * supplies everything about being an editor.
 *
 * The plugin builds its own live `EditorIo` and publishes it: a lone
 * package entry must be self-sufficient, because the host refuses a
 * plugin whose injected key nothing provides — and nothing else in the
 * configuration provides the editor's I/O. The view closure captures the
 * same implementation the plugin publishes, so the pane and any future
 * consumer read through one instance.
 */
export const editorPlugin: PluginDefinition = definePlugin({
  id: EDITOR_PLUGIN_ID,
  inject: [SessionViewsTag, SettingsTag, BindingsTag, ContextsTag, OptionsTag, PanelTag, SlotsTag],
  provide: [EditorIo, HighlightProvider, Editor, EditorControllerTag],
  effect: (ctx) =>
    Effect.gen(function* () {
      const sessionViews = yield* SessionViewsTag;
      const settings = yield* SettingsTag;
      const bindings = yield* BindingsTag;
      const contexts = yield* ContextsTag;
      const options = yield* OptionsTag;
      const panel = yield* PanelTag;
      const io: EditorIoService = yield* buildEditorIo;
      const editor = createEditor();
      const session = Option.getOrUndefined(yield* optionalEnvVar("AMUX_SESSION"));

      ctx.provide(EditorIo, io);
      ctx.provide(Editor, editor);

      // Scoped to the plugin: the worker spawns lazily on the first known
      // filetype; unload closes buffers, never the shared worker. Cached
      // grammars beyond the five bundled ones register before the first
      // buffer opens.
      const highlight = yield* makeHighlightProvider(
        undefined,
        yield* discoverCachedParsers.pipe(
          Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
        ),
      );
      ctx.provide(HighlightProvider, highlight);

      // Structural parse: scoped Parser + on-demand grammars. Build into the
      // plugin Scope (not a short Effect.provide) so the Parser finalizer
      // runs on unload, not when this yield completes — cite daemon.ts
      // Layer.build + Context.get. Runtime wasm is a declared dependency;
      // failure is PluginActivateError (host emitError on activate).
      const treeSitter = yield* Layer.build(
        treeSitterLayer.pipe(
          Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer)),
        ),
      ).pipe(
        Effect.map((services) => Context.get(services, TreeSitter)),
        Effect.mapError(
          (error) =>
            new PluginActivateError({
              message: `tree-sitter runtime unavailable (${error.path})`,
            }),
        ),
      );

      // amux.lsp/amux.search are optional peers, not declared `inject`s (the
      // editor must load standalone without them) — so the loader gives no
      // ordering guarantee against their activation. A one-shot `ctx.get`
      // here would silently freeze at "absent" forever whenever the config
      // happens to list this plugin first. Re-checking on every call instead
      // is order-independent: by the time a user can press a key or open a
      // pane, every plugin has long finished activating.
      const getLsp = (): EditorLspServices | undefined =>
        Option.all([ctx.get(DocumentService), ctx.get(LspService)]).pipe(
          Option.map(([documents, service]) => ({
            documents,
            lsp: service,
            catalog: builtInCatalog,
          })),
          Option.getOrUndefined,
        );
      const getSearch = () => Option.getOrUndefined(ctx.get(SearchService));
      const lspUi: LspUi = yield* registerLspUi;
      const fileUi: FileUi = yield* registerFileUi;

      yield* Effect.all(
        Object.entries(EDITOR_SETTINGS).map(([name, spec]) => options.register([name, spec])),
      );

      const runtime = yield* Effect.context();
      const run = (value: Parameters<typeof panel.run>[0]) =>
        Effect.runForkWith(runtime)(
          panel
            .run(value)
            .pipe(Effect.catch((error) => Effect.sync(() => panel.reportError(error.message)))),
        );

      const [controllers, setControllers] = createSignal<readonly EditorController[]>([]);
      const focusedEditor = () => controllers().find((controller) => controller.active()) ?? null;
      // Lazy grammar source — EditorPane's effect notifies on state/active flips;
      // unregister notifies so an empty controller list clears showcmd.
      const notifyShowcmd = () => bindings.pending.notify();
      const disposeGrammarPending = bindings.pending.register({
        id: "amux.editor.grammar",
        role: "grammar",
        strokes: () => {
          const focused = focusedEditor();
          return focused !== null && focused.active() ? showcmdStrokes(focused.state()) : [];
        },
      });
      const registerController = (paneId: string, controller: EditorController) => {
        setControllers((current) => [...current, controller]);
        // Bind this controller in the pane's realm, so a command dispatched
        // from this pane resolves EditorControllerTag to *this* editor. The
        // signal above stays the reactive view that context predicates read;
        // both hold the same object, registered here once.
        const unbind = ctx.provide(EditorControllerTag, controller, paneRealm(paneId));
        return () => {
          unbind();
          setControllers((current) => current.filter((entry) => entry !== controller));
          notifyShowcmd();
        };
      };

      /**
       * Run against the editor this keystroke's realm names — the pane the key
       * was typed into, not whichever editor happens to hold focus when the
       * effect runs. Silent when the realm binds no controller: the context
       * predicate already gates these commands on an active editor.
       */
      const editorEffect = (run: (controller: EditorController) => void) =>
        Effect.gen(function* () {
          const realm = yield* Realm;
          const controller = Option.getOrUndefined(realm.get(EditorControllerTag));
          if (controller !== undefined) run(controller);
        });
      // Modal overlay owns typing (picker filter). Pane vim layers would
      // otherwise stay enabled and steal those keys before OpenTUI's focused
      // <input> sees them — `j`/`i`/`a` never reach the filter.
      const active = (matches: (controller: EditorController) => boolean) => () => {
        if (fileUi.isOpen() || lspUi.isOpen()) return false;
        const controller = focusedEditor();
        return controller !== null && matches(controller);
      };
      const count = createCountAccumulator();
      const normalKeys = new Set([
        "h",
        "j",
        "k",
        "l",
        "w",
        "b",
        "e",
        "W",
        "B",
        "E",
        "0",
        "$",
        "^",
        "G",
        "H",
        "M",
        "L",
        "i",
        "a",
        "A",
        "I",
        "o",
        "O",
        "x",
        "X",
        "s",
        "S",
        "d",
        "c",
        "y",
        "p",
        "P",
        ":",
        "u",
        "g",
        "f",
        "F",
        "t",
        "T",
        ";",
        ",",
        "{",
        "}",
        "%",
        "*",
        "#",
        '"',
        "r",
        "J",
        ">",
        "<",
        "v",
        "V",
        "D",
        "C",
        "Y",
        ".",
        "/",
        "?",
        "n",
        "N",
        "escape",
      ]);
      const countInput: ContextSpec["beforeDispatch"] = (input) => {
        if (count.offer(input.event, (name) => normalKeys.has(name))) {
          input.consume({ preventDefault: true });
          input.event.preventDefault();
          return;
        }
        if (count.digits() !== "") input.setData("count", count.count());
      };
      /**
       * Count digits only. Multi-key wait (`g*` / `<leader>*` / …) is owned by
       * Bindings.chords via createBindings' global chord feed — not a second
       * beforeDispatch push (that would double-stroke the trie).
       * Cite: bindings.ts chord feed; chord-matcher.ts.
       */
      const normal: ContextSpec = {
        id: "editor.normal",
        active: active((controller) => {
          const state = controller.state();
          return (
            state.mode === "normal" &&
            state.pending === null &&
            state.pendingSurround === null &&
            state.pendingIndent === null &&
            state.pendingReplace === null &&
            state.pendingRegister === "" &&
            state.pendingFind === null &&
            state.pendingCase === null &&
            state.pendingEqual === null
          );
        }),
        priority: CONTEXT_PRIORITY.PANE,
        rebindable: false,
        beforeDispatch: countInput,
      };
      const operator: ContextSpec = {
        id: "editor.operator",
        active: active((controller) => {
          const state = controller.state();
          const pending = state.pending;
          return pending !== null && !("textObject" in pending) && state.pendingFind === null;
        }),
        priority: CONTEXT_PRIORITY.PANE + 2,
        rebindable: false,
        beforeDispatch: countInput,
        handle: (event) => dispatchEditor(event),
      };
      const textObject: ContextSpec = {
        id: "editor.text-object",
        active: active((controller) => {
          const pending = controller.state().pending;
          return pending !== null && "textObject" in pending;
        }),
        priority: CONTEXT_PRIORITY.PANE + 3,
        rebindable: false,
        handle: (event) => dispatchEditor(event),
      };
      const find: ContextSpec = {
        id: "editor.find",
        active: active((controller) => controller.state().pendingFind !== null),
        priority: CONTEXT_PRIORITY.PANE + 4,
        rebindable: false,
        handle: (event) => dispatchEditor(event),
      };
      const indent: ContextSpec = {
        id: "editor.indent",
        active: active((controller) => controller.state().pendingIndent !== null),
        priority: CONTEXT_PRIORITY.PANE + 4,
        rebindable: false,
        handle: (event) => dispatchEditor(event),
      };
      const registerPick: ContextSpec = {
        id: "editor.register",
        active: active((controller) => controller.state().pendingRegister !== ""),
        priority: CONTEXT_PRIORITY.PANE + 5,
        rebindable: false,
        handle: (event) => dispatchEditor(event),
      };
      const surround: ContextSpec = {
        id: "editor.surround",
        active: active((controller) => {
          const state = controller.state();
          return state.pendingSurround !== null && state.pendingFind === null;
        }),
        priority: CONTEXT_PRIORITY.PANE + 3,
        rebindable: false,
        beforeDispatch: countInput,
        handle: (event) => dispatchEditor(event),
      };
      const visual: ContextSpec = {
        id: "editor.visual",
        active: active((controller) => controller.state().mode === "visual"),
        priority: CONTEXT_PRIORITY.PANE,
        rebindable: false,
        beforeDispatch: countInput,
        handle: (event) => dispatchEditor(event),
      };
      const insert: ContextSpec = {
        id: "editor.insert",
        active: active((controller) => {
          const mode = controller.state().mode;
          return mode === "insert" || mode === "replace";
        }),
        priority: CONTEXT_PRIORITY.PANE,
        rebindable: false,
      };
      const commandMode: ContextSpec = {
        id: "editor.command",
        active: active((controller) => controller.state().mode === "command"),
        priority: CONTEXT_PRIORITY.PANE,
        rebindable: false,
        handle: commandKey,
      };
      // `/` and `?` leave mode "search" with an open needle — same catch-all
      // handle as command mode. Without this context, every character after `/`
      // is unclaimed (normal is inactive, captureKeys only covers insert).
      const searchMode: ContextSpec = {
        id: "editor.search",
        active: active((controller) => controller.state().mode === "search"),
        priority: CONTEXT_PRIORITY.PANE,
        rebindable: false,
        handle: (event) => dispatchEditor(event),
      };
      // Floating LSP hover: Esc/Enter/q dismiss and consume. Motions still
      // reach normal bindings; enqueue clears the popup so the box does not
      // stick to a stale cursor.
      const hoverPopup: ContextSpec = {
        id: "editor.hover",
        active: active((controller) => controller.hoverVisible()),
        priority: CONTEXT_PRIORITY.OVERLAY + 10,
        rebindable: false,
      };
      // Any focused amux.editor pane — palette power verbs (Surround) without
      // requiring vim normal / pending surround. Cite: ep-f9d55b / ts-db433b.
      const focused: ContextSpec = {
        id: "editor.focused",
        active: () => focusedEditor() !== null,
        priority: CONTEXT_PRIORITY.PANE,
        rebindable: false,
      };

      function dispatchEditor(event: KeyEvent, value?: number): boolean {
        const controller = focusedEditor();
        if (controller === null) return false;
        const mode = controller.state().mode;
        const lhs = event.sequence.length === 1 ? event.sequence : event.name;
        const rhs = editor.keymap.lookup(mode, lhs);
        if (rhs !== undefined && rhs.length === 1) {
          // Single-key remap: synthesize a printable key and dispatch that.
          // Multi-key / ex-command rhs is a later spike.
          controller.dispatch(
            {
              ...event,
              name: rhs,
              sequence: rhs,
              shift: rhs !== rhs.toLowerCase(),
            } as KeyEvent,
            value,
          );
          return true;
        }
        controller.dispatch(event, value);
        return true;
      }

      function commandKey(event: KeyEvent): boolean {
        const controller = focusedEditor();
        if (controller !== null) {
          const handled = handleCommandPickerKey(controller, event, dispatchEditor);
          if (handled !== null) return handled;
        }
        return dispatchEditor(event);
      }

      const binding = (context: ContextSpec, key: string, desc: string) =>
        contextCommand(context, {
          name: `key.${key}`,
          key,
          desc,
          group: "editor",
          run: Effect.gen(function* () {
            const invocation = yield* KeyInvocation;
            const value = invocation.data.count;
            const capturedCount = typeof value === "number" ? value : undefined;
            if (dispatchEditor(invocation.event, capturedCount)) count.reset();
          }),
        });

      const normalBindings = [
        ["h", "left"],
        ["j", "down"],
        ["k", "up"],
        ["l", "right"],
        ["w", "word forward"],
        ["b", "word back"],
        ["e", "word end"],
        ["shift+w", "WORD forward"],
        ["shift+b", "WORD back"],
        ["shift+e", "WORD end"],
        ["0", "line start"],
        ["$", "line end"],
        ["^", "first non-blank"],
        ["shift+g", "last line"],
        ["shift+h", "screen top"],
        ["shift+m", "screen middle"],
        ["shift+l", "screen bottom"],
        ["ctrl+d", "half page down"],
        ["ctrl+u", "half page up"],
        ["f", "find char forward"],
        ["shift+f", "find char back"],
        ["t", "till char forward"],
        ["shift+t", "till char back"],
        [";", "repeat find"],
        [",", "repeat find reverse"],
        ["shift+[", "paragraph back"],
        ["shift+]", "paragraph forward"],
        ["shift+5", "match paren"],
        ["%", "match paren"],
        ["*", "search word forward"],
        ["#", "search word backward"],
        ["shift+8", "search word forward"],
        ["shift+3", "search word backward"],
        ['"', "register"],
        ["i", "insert"],
        ["a", "append"],
        ["shift+a", "append at line end"],
        ["shift+i", "insert at line start"],
        ["o", "open line below"],
        ["shift+o", "open line above"],
        ["x", "delete character"],
        ["shift+x", "delete before"],
        ["s", "substitute char"],
        ["shift+s", "substitute line"],
        ["d", "delete"],
        ["c", "change"],
        ["y", "yank"],
        ["p", "put after"],
        ["shift+p", "put before"],
        ["r", "replace"],
        ["shift+j", "join"],
        [">", "indent"],
        ["<", "dedent"],
        ["v", "visual"],
        ["shift+v", "visual line"],

        ["/", "search forward"],
        ["shift+/", "search backward"],
        ["n", "next search"],
        ["shift+n", "prev search"],
        [".", "repeat change"],
        [":", "command"],
        ["u", "undo"],
        ["escape", "clear pending"],
      ] as const;
      const motionBindings = [
        ["h", "left"],
        ["j", "down"],
        ["k", "up"],
        ["l", "right"],
        ["w", "word forward"],
        ["b", "word back"],
        ["e", "word end"],
        ["shift+w", "WORD forward"],
        ["shift+b", "WORD back"],
        ["shift+e", "WORD end"],
        ["0", "line start"],
        ["$", "line end"],
        ["^", "first non-blank"],
        ["shift+g", "last line"],
        ["shift+h", "screen top"],
        ["shift+m", "screen middle"],
        ["shift+l", "screen bottom"],
        ["ctrl+d", "half page down"],
        ["ctrl+u", "half page up"],
        ["f", "find char forward"],
        ["shift+f", "find char back"],
        ["t", "till char forward"],
        ["shift+t", "till char back"],
        [";", "repeat find"],
        [",", "repeat find reverse"],
        ["shift+[", "paragraph back"],
        ["shift+]", "paragraph forward"],
        ["shift+5", "match paren"],
        ["%", "match paren"],
        ["d", "line delete"],
        ["c", "line change"],
        ["y", "line yank"],
        ["i", "inner text object"],
        ["a", "outer text object"],
        ["s", "surround"],
        ["escape", "cancel operator"],
      ] as const;
      const textObjectBindings = [
        ["w", "word"],
        ["shift+w", "WORD"],
        ["p", "paragraph"],
        ["(", "parentheses"],
        ['"', "quotes"],
        ["{", "braces"],
        ["[", "brackets"],
        ["<", "angle brackets"],
        ["escape", "cancel operator"],
      ] as const;

      yield* Effect.forEach(
        [
          normal,
          operator,
          textObject,
          surround,
          find,
          indent,
          registerPick,
          visual,
          insert,
          commandMode,
          searchMode,
          hoverPopup,
          focused,
        ],
        (context) => contexts.register(context),
      );
      yield* Effect.forEach(normalBindings, ([key, desc]) =>
        bindings.register(binding(normal, key, desc)),
      );
      // Always registered — never gated on getLsp() at setup time, since
      // that would freeze on whatever amux.lsp's activation state happened
      // to be at this exact instant. EditorController checks lspClient()
      // itself per buffer and no-ops without one; getLsp() is re-read fresh
      // by the session view factory each time a pane opens, below.
      yield* bindings.register(
        contextCommand(normal, {
          name: "key.shift+k",
          key: "shift+k",
          desc: "LSP hover",
          group: "editor",
          run: editorEffect((editor) => editor.requestHover()),
        }),
      );
      for (const key of ["escape", "return", "enter", "q"] as const) {
        yield* bindings.register(
          contextCommand(hoverPopup, {
            name: `hover.dismiss.${key}`,
            key,
            desc: "close hover",
            group: "editor",
            run: editorEffect((editor) => editor.dismissHover()),
          }),
        );
      }
      // Mapping chords as CommandSpecs — syncCommandChords mirrors them onto
      // Bindings.chords so prefix-wait / showcmd / which-key share one trie.
      // Builtin `g*` / `z*` share the table with LSP (`grr`, …). Matched
      // builtins apply via runBuiltinMap; they do not feedVim raw keys back
      // into a pendingG flag. Cite: maps.ts; chord-matcher.ts; ts-b36737.
      const feedVim = (strokes: readonly string[]) => {
        const controller = focusedEditor();
        if (controller === null) return;
        for (const stroke of strokes) {
          const shift =
            stroke.startsWith("shift+") || (stroke.length === 1 && stroke !== stroke.toLowerCase());
          const name = stroke.startsWith("shift+")
            ? stroke.slice("shift+".length)
            : stroke.length === 1
              ? stroke.toLowerCase()
              : stroke;
          controller.dispatch({
            name,
            sequence: stroke.length === 1 ? stroke : "",
            shift,
            ctrl: false,
            meta: false,
            option: false,
            eventType: "press",
            raw: stroke,
          } as KeyEvent);
        }
      };
      const applyBuiltin = (id: BuiltinMapId) =>
        editorEffect((editor) => {
          editor.apply((state) => runBuiltinMap(state, id));
        });
      bindings.chords.setAmbiguousTimeout((strokes) => {
        // Mux `<prefix>` wait abandons; do not feed vim a token name.
        if (strokes[0] === "<prefix>") return;
        // `<leader>` is a chord token; vim-core wants the physical key (space).
        feedVim(strokes.map((stroke) => (stroke === "<leader>" ? bindings.leader() : stroke)));
      });
      // Dual-scope builtins (gg/ge/gE) register under normal *and* operator so
      // `dgg` keeps working — mutually exclusive contexts, same key token.
      // Key form is unspaced (`grr`, `gshift+d`); spaces are literal keys.
      const mapContexts = (scopes: readonly MapScope[]) =>
        scopes.flatMap((scope) => {
          if (scope === "normal") return [normal];
          if (scope === "operator") return [operator];
          return [];
        });
      yield* Effect.forEach(BUILTIN_MAPS, (entry) =>
        Effect.forEach(mapContexts(entry.scopes), (context) =>
          bindings.register(
            contextCommand(context, {
              name: `map.${entry.id}`,
              key: entry.bindingStrokes.join(""),
              desc: entry.id,
              group: "editor",
              hidden: true,
              run: applyBuiltin(entry.id),
            }),
          ),
        ),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "map.g+.shift",
          key: "gshift+=",
          desc: "g+",
          group: "editor",
          hidden: true,
          run: applyBuiltin("g+"),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.references",
          key: "grr",
          desc: "LSP references",
          group: "editor",
          run: editorEffect((editor) => editor.requestReferences()),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.definition",
          key: "grd",
          desc: "LSP definition",
          group: "editor",
          run: editorEffect((editor) => editor.requestDefinition()),
        }),
      );
      // Vim `gd` / `gD` — LSP definition (declaration API not wired yet).
      // Cite: neovim `gd` local / `gD` global; both map to textDocument/definition.
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.gd",
          key: "gd",
          desc: "LSP definition (gd)",
          group: "editor",
          run: editorEffect((editor) => editor.requestDefinition()),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.gD",
          key: "gshift+d",
          desc: "LSP declaration (gD)",
          group: "editor",
          run: editorEffect((editor) => editor.requestDeclaration()),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.implementation",
          key: "gri",
          desc: "LSP implementation",
          group: "editor",
          run: editorEffect((editor) => editor.requestImplementation()),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.typeDefinition",
          key: "grt",
          desc: "LSP type definition",
          group: "editor",
          run: editorEffect((editor) => editor.requestTypeDefinition()),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.codeAction",
          key: "gra",
          desc: "LSP code action",
          group: "editor",
          run: editorEffect((editor) => editor.requestCodeAction()),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.codeLens",
          key: "grx",
          desc: "LSP code lens",
          group: "editor",
          run: editorEffect((editor) => editor.requestCodeLens()),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.documentSymbols",
          key: "gshift+o",
          desc: "LSP document symbols",
          group: "editor",
          run: editorEffect((editor) => editor.requestDocumentSymbols()),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.diagnosticNext",
          key: "]d",
          desc: "next diagnostic",
          group: "editor",
          run: editorEffect((editor) => editor.jumpDiagnostic("next")),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.diagnosticPrev",
          key: "[d",
          desc: "previous diagnostic",
          group: "editor",
          run: editorEffect((editor) => editor.jumpDiagnostic("prev")),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.diagnosticLast",
          key: "]shift+d",
          desc: "last diagnostic",
          group: "editor",
          run: editorEffect((editor) => editor.jumpDiagnostic("last")),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.diagnosticFirst",
          key: "[shift+d",
          desc: "first diagnostic",
          group: "editor",
          run: editorEffect((editor) => editor.jumpDiagnostic("first")),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.diagnosticFloat",
          key: "gl",
          desc: "diagnostic under cursor",
          group: "editor",
          // nvim uses <C-W>d — mux owns CTRL-W, so `gl` (show diagnostics float).
          run: editorEffect((editor) => editor.showDiagnosticFloat()),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "map.gstar.shift",
          key: "gshift+8",
          desc: "g*",
          group: "editor",
          hidden: true,
          run: applyBuiltin("g*"),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "map.ghash.shift",
          key: "gshift+3",
          desc: "g#",
          group: "editor",
          hidden: true,
          run: applyBuiltin("g#"),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "lsp.rename",
          key: "grn",
          desc: "LSP rename",
          group: "editor",
          run: editorEffect((editor) => editor.requestRename()),
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          disposeGrammarPending();
          bindings.chords.setAmbiguousTimeout(null);
        }),
      );
      yield* Effect.forEach(motionBindings, ([key, desc]) =>
        bindings.register(binding(operator, key, desc)),
      );
      yield* Effect.forEach(textObjectBindings, ([key, desc]) =>
        bindings.register(binding(textObject, key, desc)),
      );
      yield* bindings.register(binding(insert, "escape", "normal mode"));
      yield* bindings.register(
        contextCommand(insert, {
          name: "key.ctrl+s",
          key: "ctrl+s",
          desc: "LSP signature help",
          group: "editor",
          run: editorEffect((editor) => editor.requestSignatureHelp()),
        }),
      );

      yield* sessionViews.register([
        "amux.editor",
        (props) => (
          <EditorPane
            {...props}
            run={run}
            spaceDir={spaceDirOf(panel)}
            lineNumbers={() => settingValue(panel, "editor.number")}
            keyProfile={() => settingValue(panel, "editor.keyProfile")}
            io={io}
            session={session}
            editor={editor}
            highlight={highlight}
            treeSitter={treeSitter}
            lsp={getLsp}
            lspUi={lspUi}
            search={getSearch}
            registerController={registerController}
            onShowcmdSync={notifyShowcmd}
          />
        ),
      ]);

      yield* settings.register({
        id: EDITOR_PLUGIN_ID,
        label: "editor",
        rows: () => Object.keys(EDITOR_SETTINGS).length,
        keys: (event: KeyEvent, selected: number) => {
          const name = SETTING_NAMES[selected];
          if (!name) return false;
          const spec = EDITOR_SETTINGS[name];
          if (spec.kind === "boolean") {
            if (event.name === "return" || event.name === "enter" || event.name === " ") {
              panel.setOption(name, !settingValue(panel, name));
              panel.saveOptions();
              return true;
            }
            return false;
          }
          if (spec.kind === "enum") {
            if (
              event.name === "return" ||
              event.name === "enter" ||
              event.name === " " ||
              event.name === "right" ||
              event.name === "l"
            ) {
              cycleEnumSetting(panel, name, 1);
              return true;
            }
            if (event.name === "left" || event.name === "h") {
              cycleEnumSetting(panel, name, -1);
              return true;
            }
          }
          return false;
        },
        component: (props) => (
          <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
            {SETTING_NAMES.map((name, index) => (
              <text
                style={{
                  height: 1,
                  flexShrink: 0,
                  fg: index === props.selected ? theme.mauve : theme.text,
                  bg: index === props.selected ? theme.surface0 : theme.base,
                }}
              >
                {name} = {String(settingValue(panel, name))}
              </text>
            ))}
          </box>
        ),
      });

      // Editor chords use `<leader>` (default space) — not the mux `<prefix>`
      // (ctrl+s). CommandSpecs with `<leader>*` sync onto Bindings.chords in
      // createBindings.apply (showcmd + which-key + map-fail retry).
      const openPicked = (path: string) => {
        const focused = focusedEditor();
        if (focused !== null) {
          focused.openPath(path);
          return;
        }
        Effect.runForkWith(runtime)(
          editorOpenCommand({ file: path }).pipe(Effect.flatMap((cmd) => panel.run(cmd))),
        );
      };
      const findFiles = (title: string, query: string) => {
        const search = getSearch();
        if (search === undefined) {
          panel.reportError("amux.search plugin required for file find");
          return;
        }
        fileUi.findFiles(search, title, query, openPicked);
      };
      const openEditor = () => {
        Effect.runForkWith(runtime)(
          editorOpenCommand({}).pipe(Effect.flatMap((cmd) => panel.run(cmd))),
        );
      };
      const findFile = () => findFiles("find files", "");
      const findSibling = () => {
        const file = focusedEditor()?.state().file ?? null;
        if (file === null) {
          panel.reportError("no file — open a buffer first");
          return;
        }
        const slash = file.lastIndexOf("/");
        const dir = slash < 0 ? "." : file.slice(0, slash);
        Effect.runForkWith(runtime)(
          io.listEntries("", dir).pipe(
            Effect.map((entries) =>
              entries
                .filter((entry) => entry.kind === "file")
                .map((entry): import("@danielfgray/amux-plugin-completion").CompletionItem => ({
                  id: `${dir}/${entry.name}`,
                  label: entry.name,
                  detail: "sibling",
                  replacement: `${dir}/${entry.name}`,
                })),
            ),
            Effect.tap((items) =>
              Effect.sync(() => fileUi.pickFile("sibling files", items, openPicked)),
            ),
            Effect.catch((error) => Effect.sync(() => panel.reportError(String(error)))),
          ),
        );
      };
      // Multi-key `<leader>*` CommandSpecs sync onto Bindings.chords in
      // createBindings.apply — no hand dual-register. Cite: bindings.ts
      // syncCommandChords.
      yield* bindings.register(
        contextCommand(normal, {
          name: "open",
          key: "<leader>e",
          desc: "open an editor pane",
          group: "editor",
          run: Effect.sync(openEditor),
        }),
      );
      // Mux `<prefix>f` / `<prefix>s` are unrelated; leader chords stay on
      // the editor layer and do not collide with them.
      yield* bindings.register(
        contextCommand(normal, {
          name: "find-file",
          key: "<leader>/",
          desc: "find file in project",
          group: "editor",
          run: Effect.sync(findFile),
        }),
      );
      yield* bindings.register(
        contextCommand(normal, {
          name: "find-sibling",
          key: "<leader>.",
          desc: "find sibling file",
          group: "editor",
          run: Effect.sync(findSibling),
        }),
      );
      // Palette power verb: active only while an editor pane owns focus.
      // Unbound — CUA users discover it in the context-ranked palette; vim
      // users still have ys/ds/cs. `:Surround )` applies immediately.
      yield* bindings.register(
        contextCommand(focused, {
          name: "surround",
          key: "",
          desc: "surround selection or word",
          group: "editor",
          run: Effect.sync(() => {
            const controller = focusedEditor();
            if (controller === null) return;
            controller.apply(beginSurround);
          }),
        }),
      );
      yield* bindings.register(
        contextCommand(focused, {
          name: "search",
          key: "",
          desc: "search in buffer",
          group: "editor",
          run: Effect.sync(() => {
            const controller = focusedEditor();
            if (controller === null) return;
            controller.apply((state) => beginSearch(state, "forward"));
          }),
        }),
      );
      yield* bindings.register(
        contextCommand(focused, {
          name: "substitute",
          key: "",
          desc: "substitute in buffer (:%s/)",
          group: "editor",
          run: Effect.sync(() => {
            const controller = focusedEditor();
            if (controller === null) return;
            controller.apply(beginSubstitute);
          }),
        }),
      );
      const disposeSurround = editor.command.add("Surround", {
        aliases: ["surround"],
        nargs: "1",
        run: ({ arg }) => {
          const controller = focusedEditor();
          if (controller === null) return;
          controller.apply((state) => applySurround(state, arg));
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(disposeSurround));
    }),
});

/** The active space's directory — where :e/:w root relative paths, per the
 *  epic's open-path decision. Read live so a space switch moves the editor's
 *  root with it. */
function spaceDirOf(panel: PanelContext): string {
  const snapshot = panel.snapshot();
  const active = snapshot.spaces.find((space) => space.id === snapshot.state.activeSpace);
  return active?.dir ?? "";
}

export default editorPlugin;

export {
  createEditor,
  Editor,
  type AddCommandSpec,
  type CommandRunArgs,
  type EditorService,
  type RegisteredCommand,
} from "./api.ts";
