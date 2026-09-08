/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { KeyEvent } from "@opentui/core";
import { definePlugin, type PluginDefinition } from "@danielfgray/amux";
import {
  BindingsTag,
  CONTEXT_PRIORITY,
  ContextsTag,
  createCountAccumulator,
  KeyInvocation,
  OptionsTag,
  PanelTag,
  SessionViewsTag,
  SettingsTag,
  theme,
} from "@danielfgray/amux";
import { contextCommand, type ContextSpec, type PanelContext } from "@danielfgray/amux";
import { command } from "@danielfgray/amux";
import type { OptionSpec } from "@danielfgray/amux";
import { EditorPane, type EditorController } from "./EditorPane.tsx";
import { EditorIo, type EditorIoService } from "./io.ts";

export const EDITOR_PLUGIN_ID = "amux.editor";

export const EDITOR_SETTINGS = {
  "editor.number": { kind: "boolean", default: true, desc: "show line numbers" },
} as const satisfies Record<string, OptionSpec>;

type EditorSettingName = keyof typeof EDITOR_SETTINGS;
const SETTING_NAMES = Object.keys(EDITOR_SETTINGS) as EditorSettingName[];

function settingValue(panel: PanelContext, name: EditorSettingName): boolean {
  const spec = EDITOR_SETTINGS[name];
  const value = panel.options()[name];
  return (value === undefined ? spec.default : value) as boolean;
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
  return EditorIo.of({
    read: (file, spaceDir) =>
      Effect.gen(function* () {
        const resolved = path.resolve(spaceDir, file);
        const text = yield* fs.readFileString(resolved);
        const lines = text.split("\n");
        if (lines.at(-1) === "") return { file: resolved, lines: lines.slice(0, -1) };
        return { file: resolved, lines };
      }),
    write: (file, lines, spaceDir) =>
      Effect.gen(function* () {
        const resolved = file.startsWith("/") ? file : path.resolve(spaceDir, file);
        yield* fs.writeFileString(resolved, lines.join("\n") + "\n");
      }),
    resolve: (spaceDir, p) =>
      Effect.sync(() => (p.startsWith("/") ? p : path.resolve(spaceDir, p))),
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
  inject: [SessionViewsTag, SettingsTag, BindingsTag, ContextsTag, OptionsTag, PanelTag],
  provide: [EditorIo],
  effect: (ctx) =>
    Effect.gen(function* () {
      const sessionViews = yield* SessionViewsTag;
      const settings = yield* SettingsTag;
      const bindings = yield* BindingsTag;
      const contexts = yield* ContextsTag;
      const options = yield* OptionsTag;
      const panel = yield* PanelTag;
      const io: EditorIoService = yield* buildEditorIo;

      ctx.provide(EditorIo, io);

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
      const registerController = (controller: EditorController) => {
        setControllers((current) => [...current, controller]);
        return () => setControllers((current) => current.filter((entry) => entry !== controller));
      };
      const active = (matches: (controller: EditorController) => boolean) => () => {
        const controller = focusedEditor();
        return controller !== null && matches(controller);
      };
      const count = createCountAccumulator();
      const normalKeys = new Set(["h", "j", "k", "l", "w", "b", "e", "0", "$", "^", "G", "i", "a", "A", "I", "o", "O", "x", "d", "c", "y", "p", "P", ":", "u", "g", "escape"]);
      const countInput: ContextSpec["beforeDispatch"] = (input) => {
        if (count.offer(input.event, (name) => normalKeys.has(name))) {
          input.consume({ preventDefault: true });
          input.event.preventDefault();
          return;
        }
        if (count.digits() !== "") input.setData("count", count.count());
      };
      const normal: ContextSpec = {
        id: "editor.normal",
        active: active((controller) => {
          const state = controller.state();
          return state.mode === "normal" && state.pending === null && !state.pendingG;
        }),
        priority: CONTEXT_PRIORITY.PANE,
        rebindable: false,
        beforeDispatch: countInput,
      };
      const operator: ContextSpec = {
        id: "editor.operator",
        active: active((controller) => {
          const pending = controller.state().pending;
          return pending !== null && !("textObject" in pending);
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
      const gPrefix: ContextSpec = {
        id: "editor.g-prefix",
        active: active((controller) => controller.state().pendingG),
        priority: CONTEXT_PRIORITY.PANE + 1,
        rebindable: false,
        handle: (event) => dispatchEditor(event),
      };
      const insert: ContextSpec = {
        id: "editor.insert",
        active: active((controller) => controller.state().mode === "insert"),
        priority: CONTEXT_PRIORITY.PANE,
        rebindable: false,
      };
      const commandMode: ContextSpec = {
        id: "editor.command",
        active: active((controller) => controller.state().mode === "command"),
        priority: CONTEXT_PRIORITY.PANE,
        rebindable: false,
        handle: (event) => dispatchEditor(event),
      };

      function dispatchEditor(event: KeyEvent, value?: number): boolean {
        const controller = focusedEditor();
        if (controller === null) return false;
        controller.dispatch(event, value);
        return true;
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
        ["h", "left"], ["j", "down"], ["k", "up"], ["l", "right"],
        ["w", "word forward"], ["b", "word back"], ["e", "word end"], ["0", "line start"],
        ["$", "line end"], ["^", "first non-blank"], ["shift+g", "last line"], ["g", "go to first line"],
        ["i", "insert"], ["a", "append"], ["shift+a", "append at line end"], ["shift+i", "insert at line start"],
        ["o", "open line below"], ["shift+o", "open line above"], ["x", "delete character"],
        ["d", "delete"], ["c", "change"], ["y", "yank"], ["p", "put after"], ["shift+p", "put before"],
        [":", "command"], ["u", "undo"], ["escape", "clear pending"],
      ] as const;
      const motionBindings = [
        ["h", "left"], ["j", "down"], ["k", "up"], ["l", "right"], ["w", "word forward"],
        ["b", "word back"], ["e", "word end"], ["0", "line start"], ["$", "line end"],
        ["^", "first non-blank"], ["shift+g", "last line"], ["d", "line delete"],
        ["c", "line change"], ["y", "line yank"], ["i", "inner text object"],
        ["a", "outer text object"], ["escape", "cancel operator"],
      ] as const;
      const textObjectBindings = [
        ["w", "word"], ["p", "paragraph"], ["(", "parentheses"], ["\"", "quotes"],
        ["{", "braces"], ["[", "brackets"], ["<", "angle brackets"], ["escape", "cancel operator"],
      ] as const;

      yield* Effect.forEach([normal, gPrefix, operator, textObject, insert, commandMode], (context) =>
        contexts.register(context),
      );
      yield* Effect.forEach(normalBindings, ([key, desc]) => bindings.register(binding(normal, key, desc)));
      yield* Effect.forEach(motionBindings, ([key, desc]) => bindings.register(binding(operator, key, desc)));
      yield* Effect.forEach(textObjectBindings, ([key, desc]) =>
        bindings.register(binding(textObject, key, desc)),
      );
      yield* bindings.register(binding(gPrefix, "g", "first line"));
      yield* bindings.register(binding(insert, "escape", "normal mode"));

      yield* sessionViews.register([
        "amux.editor",
        (props) => (
          <EditorPane
            {...props}
            run={run}
            spaceDir={spaceDirOf(panel)}
            lineNumbers={() => settingValue(panel, "editor.number")}
            io={io}
            registerController={registerController}
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
          if (event.name === "return" || event.name === "enter" || event.name === " ") {
            panel.setOption(name, !settingValue(panel, name));
            return true;
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

      yield* bindings.register({
        name: "editor.open",
        key: "<leader>e",
        desc: "open an editor pane",
        group: "editor",
        run: panel.run(command("editor.open")),
      });
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
