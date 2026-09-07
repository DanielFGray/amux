/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- the plugin registers Solid views and key sections, whose lifecycle belongs to OpenTUI/Solid. */
import { Effect } from "effect";
import type { KeyEvent } from "@opentui/core";
import { definePlugin, type PluginDefinition } from "@danielfgray/amux";
import {
  BindingsTag,
  OptionsTag,
  PanelTag,
  SessionViewsTag,
  SettingsTag,
  theme,
} from "@danielfgray/amux";
import type { PanelContext } from "@danielfgray/amux";
import { command } from "@danielfgray/amux";
import type { OptionSpec } from "@danielfgray/amux";
import { EditorPane } from "./EditorPane.tsx";

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
 * The vim editor as a plugin — the pane-side stress test of the plugin API.
 *
 * Everything a real editor needs is acquired here: the session view (renders
 * the buffer in a pane), the line-number setting, and a binding that opens a
 * scratch buffer. Core supplies the
 * pane seam — `pane.open-plugin` places a sessionless pane, `captureKeys`
 * hands it the unclaimed keys, `pane.set-descriptor` persists which file it
 * shows — and this plugin supplies everything about being an editor.
 */
export const editorPlugin: PluginDefinition = definePlugin({
  id: EDITOR_PLUGIN_ID,
  inject: [SessionViewsTag, SettingsTag, BindingsTag, OptionsTag, PanelTag],
  effect: () =>
    Effect.gen(function* () {
      const sessionViews = yield* SessionViewsTag;
      const settings = yield* SettingsTag;
      const bindings = yield* BindingsTag;
      const options = yield* OptionsTag;
      const panel = yield* PanelTag;

      yield* Effect.all(
        Object.entries(EDITOR_SETTINGS).map(([name, spec]) => options.register([name, spec])),
      );

      const run = (value: Parameters<typeof panel.run>[0]) =>
        Effect.runFork(
          panel
            .run(value)
            .pipe(Effect.catch((error) => Effect.sync(() => panel.reportError(error.message)))),
        );

      yield* sessionViews.register([
        "amux.editor",
        (props) => (
          <EditorPane
            {...props}
            run={run}
            spaceDir={spaceDirOf(panel)}
            lineNumbers={() => settingValue(panel, "editor.number")}
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

      // A binding's effect is built once, so the command value is built here
      // too — pane.open-plugin's arguments are fixed at registration.
      yield* bindings.register({
        name: "editor.open",
        key: "<leader>e",
        desc: "open an editor pane",
        group: "editor",
        run: panel.run(command("pane.open-plugin", { type: "amux.editor", descriptor: {} })),
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
