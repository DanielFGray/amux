/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { Context, Data, Duration, Effect, Layer, Option, Schedule } from "effect";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { RendererContext, _render } from "@opentui/solid";
import {
  testEffect,
  testPanelContext,
  testPluginEnvironment,
  waitFor,
} from "@danielfgray/amux/testing";
import {
  BindingsTag,
  ContextsTag,
  OptionsTag,
  resolveOptions,
  SettingsTag,
} from "@danielfgray/amux";
import type { Command, JsonValue, PaneViewProps } from "@danielfgray/amux";
import { theme } from "@danielfgray/amux";
import { createPluginHost, type PluginHost } from "@danielfgray/amux/plugin/host.ts";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { editorPlugin, Editor, handleCommandPickerKey } from "./plugin.tsx";
import { createEditor } from "./api.ts";
import { EditorPane, type EditorController } from "./EditorPane.tsx";
import {
  makeHighlightProvider,
  TreeSitter,
  treeSitterLayer,
  type HighlightProviderService,
} from "@danielfgray/amux-highlight";
import { makeTestEditorIo, type TestEditorIoState } from "./test/io.ts";
import type { EditorService } from "./api.ts";
import { linesOf } from "./buffer-state.ts";

const applyHostConfig = (host: PluginHost, entries: Parameters<PluginHost["prepare"]>[0]) =>
  host.prepare(entries).pipe(Effect.tap(() => host.publish));

const WIDTH = 60;
const HEIGHT = 16;

type Renderer = Awaited<ReturnType<typeof createTestRenderer>>;

const keystroke = (name: string): KeyEvent =>
  ({ raw: name, sequence: name, name, eventType: "press" }) as KeyEvent;

/** Real TreeSitter into the ambient testEffect Scope (daemon Layer.build). */
const buildTreeSitter = () =>
  Layer.build(
    treeSitterLayer.pipe(
      Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer)),
    ),
  ).pipe(Effect.map((services) => Context.get(services, TreeSitter)));

type Registries = ReturnType<typeof testPluginEnvironment>["registries"];

/** What the recorder keeps. A core command and a plugin verb both reach
 *  `run`, and they share only their tag — which is all an assertion here
 *  needs, since `run` records the command value rather than a serialized
 *  copy of it. */
type SentCommand = { readonly _tag: string };

/** The commands the pane sent, narrowed to one tag. */
const tagged = (sent: readonly SentCommand[], tag: string) =>
  sent.filter((value) => value._tag === tag);

/** The frame the test was waiting for never arrived. Tagged rather than a bare
 *  `Error` so the retry below can key on it. */
class FrameNeverCame extends Data.TaggedError("FrameNeverCame")<{ readonly what: string }> {}

/** Render frames until `predicate` holds. The editor's state reaches the
 *  screen through a fiber, so a test cannot assert on the frame it triggered;
 *  it has to let the renderer catch up. */
const waitForFrame = (t: Renderer, predicate: () => boolean, what: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => t.renderOnce());
    if (!predicate()) return yield* new FrameNeverCame({ what });
  }).pipe(
    Effect.retry(Schedule.spaced("20 millis")),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => new FrameNeverCame({ what }),
    }),
  );

/** Activate the editor plugin in a test environment: a renderer, a panel
 *  stub whose run records the commands the editor sends, and a live plugin
 *  host running the registry entries plus the editor. This covers
 *  registration — the view, the settings section, the binding. */
const activate = (sent: SentCommand[], seenBindings: string[] = [], lineNumbers = true) =>
  Effect.gen(function* () {
    const t = yield* Effect.promise(() => createTestRenderer({ width: WIDTH, height: HEIGHT }));
    // Registered before the host exists, so it runs after the host's own
    // finalizers when the test's scope closes: the plugin tears down against
    // a live renderer, then the renderer goes.
    yield* Effect.addFinalizer(() =>
      Effect.sleep("50 millis").pipe(Effect.andThen(Effect.sync(() => t.renderer.destroy()))),
    );
    const panel = testPanelContext({
      snapshot: () =>
        ({
          revision: 0,
          spaces: [{ id: "space-a", dir: "/workspace", name: "test", windows: [] }],
          state: { activeSpace: "space-a", nextSpace: 2 },
        }) as never,
      options: () => ({ ...resolveOptions({}), "editor.number": lineNumbers }),
      // Pure at construction like the real panel.run: the push happens when
      // the returned Effect runs, not when the command value is built.
      run: (value) =>
        Effect.as(
          Effect.sync(() => {
            sent.push(value);
          }),
          {} as never,
        ),
    });
    const bindingsOverride: Registries["bindings"] = (owner, binding) => {
      seenBindings.push(binding.name);
      void owner;
      return () => {};
    };
    const environment = testPluginEnvironment(t.renderer, {
      panel,
      registries: { bindings: bindingsOverride },
    });
    const host: PluginHost = yield* createPluginHost(environment);
    const prepared = yield* applyHostConfig(host, [...environment.registryEntries, editorPlugin]);
    expect(prepared.refused).toEqual([]);
    // Registration rides a forked activation fiber; wait for its side effect
    // rather than sleeping a fixed beat.
    yield* Effect.promise(() =>
      waitFor(
        () => environment.registries.sessionViews.has("amux.editor"),
        "editor view registration",
      ),
    );
    return { t, environment, host };
  });

/** Mount the editor view directly with an in-memory `EditorIo`, the way
 *  the bench does — and hand back the captureKeys handler the view
 *  registers on mount. The plugin's own activation builds the live
 *  filesystem implementation, which a test must not touch; mounting the
 *  view directly is how behavior tests swap it for memory. */
const mount = (
  t: Renderer,
  ioState: TestEditorIoState,
  descriptor: JsonValue,
  sent: SentCommand[],
  lineNumbers = true,
  highlight?: HighlightProviderService,
  editor?: EditorService,
) =>
  Effect.gen(function* () {
    const treeSitter = yield* buildTreeSitter();
    const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
    t.renderer.root.add(paneHost);
    const content = new BoxRenderable(t.renderer, {
      id: "pane-1-content",
      position: "absolute",
      width: WIDTH - 2,
      height: HEIGHT - 2,
    });
    paneHost.add(content);
    let capture: ((event: KeyEvent) => boolean) | null = null;
    let controller: EditorController | null = null;
    const props: PaneViewProps = {
      sessionId: "",
      paneId: "pane-1",
      paneType: "amux.editor",
      descriptor,
      width: () => WIDTH - 2,
      height: () => HEIGHT - 2,
      active: () => true,
      copyText: () => {},
      captureKeys: (handler) => {
        capture = handler;
      },
    };
    const run = (value: Command) => {
      sent.push(value);
    };
    // Mount into the test renderer the way ComponentPane does — _render takes
    // the existing context rather than creating a second CliRenderer.
    const renderer = t.renderer as CliRenderer;
    const dispose = _render(
      () => (
        <RendererContext.Provider value={renderer}>
          <EditorPane
            {...props}
            run={run}
            spaceDir={ioState.spaceDir}
            lineNumbers={() => lineNumbers}
            keyProfile={() => "vim"}
            io={makeTestEditorIo(ioState)}
            editor={editor}
            highlight={highlight}
            treeSitter={treeSitter}
            registerController={(_paneId, next) => {
              controller = next;
              return () => {
                controller = null;
              };
            }}
          />
        </RendererContext.Provider>
      ),
      content,
    );
    yield* Effect.addFinalizer(() => Effect.sync(dispose));
    return {
      content,
      capture: () => capture,
      controller: () => controller,
      press: (event: KeyEvent) => {
        if (controller === null) throw new Error("editor controller was not registered");
        // Same path as the plugin's editor.command context — direct dispatch
        // alone would miss the picker-Enter contract.
        const handled = handleCommandPickerKey(controller, event, (next) => {
          controller!.dispatch(next);
          return true;
        });
        if (handled !== null) return;
        controller.dispatch(event);
      },
    };
  });

/** A `TestEditorIo` state with the given files preloaded. The `spaceDir`
 *  is what the pane roots relative paths at; the tests below use it the
 *  way the plugin uses the active space's directory. */
function makeIo(spaceDir: string, files: Record<string, string[]> = {}): TestEditorIoState {
  return { files: new Map(Object.entries(files)), failReads: new Set(), spaceDir };
}

testEffect(
  "the editor plugin registers a view, a settings section, and a binding",
  Effect.gen(function* () {
    const sent: SentCommand[] = [];
    const seenBindings: string[] = [];
    const { environment, host } = yield* activate(sent, seenBindings);
    expect(environment.registries.sessionViews.has("amux.editor")).toBe(true);
    const settings = Option.getOrThrow(host.get(SettingsTag)).all();
    expect(settings.some((section) => section.id === "amux.editor")).toBe(true);
    const options = Option.getOrThrow(host.get(OptionsTag));
    expect(options.all().map((entry) => entry.name)).toEqual([
      "editor.number",
      "editor.keyProfile",
    ]);
    expect(seenBindings.includes("editor.normal.open")).toBe(true);
    expect(seenBindings.includes("editor.normal.find-file")).toBe(true);
    expect(seenBindings.includes("editor.normal.find-sibling")).toBe(true);
    expect(seenBindings.includes("editor.focused.surround")).toBe(true);
    expect(seenBindings.includes("editor.focused.search")).toBe(true);
    expect(seenBindings.includes("editor.focused.substitute")).toBe(true);
    // Multi-stroke maps/LSP are CommandSpecs (one dispatch path); syncCommandChords
    // mirrors them onto the shared trie. Cite: ts-b36737.
    expect(seenBindings.includes("editor.normal.lsp.references")).toBe(true);
    expect(seenBindings.includes("editor.normal.map.gg")).toBe(true);
    expect(seenBindings.includes("editor.operator.map.gg")).toBe(true);
    // Test host stubs bindings.register (records names only), so hidden flags
    // are not on Bindings.commands() here — covered by the registration source.
    expect(
      Duration.toMillis(Option.getOrThrow(host.get(BindingsTag)).chords.timeoutlen()),
    ).toBeGreaterThan(0);
    expect(seenBindings.includes("editor.operator.key.w")).toBe(true);
    expect(seenBindings.includes("editor.insert.key.escape")).toBe(true);
    expect(
      Option.getOrThrow(host.get(ContextsTag))
        .all()
        .map((context) => context.id),
    ).toEqual([
      "amux.editor.lsp-ui",
      "amux.editor.file-ui",
      "editor.normal",
      "editor.operator",
      "editor.text-object",
      "editor.surround",
      "editor.find",
      "editor.indent",
      "editor.register",
      "editor.visual",
      "editor.insert",
      "editor.command",
      "editor.search",
      "editor.hover",
      "editor.focused",
    ]);
    expect(Option.isSome(host.get(Editor))).toBe(true);
    expect(
      Option.getOrThrow(host.get(Editor))
        .command.list()
        .map((c) => c.name),
    ).toContain("Surround");
    expect(sent).toEqual([]);
  }),
);

testEffect(
  "a user :command registered on Editor runs through the pane",
  Effect.gen(function* () {
    const ioState = makeIo("/workspace");
    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const editor = createEditor();
    const seen: string[] = [];
    editor.command.add("Echo", {
      nargs: "1",
      run: ({ arg }) => {
        seen.push(arg);
      },
    });
    const pane = yield* mount(t, ioState, null, sent, true, undefined, editor);
    for (const name of [":", "E", "c", "h", "o", " ", "h", "i", "return"]) {
      pane.press(keystroke(name));
    }
    yield* waitForFrame(t, () => seen.length === 1, "user command invoke");
    expect(seen).toEqual(["hi"]);
  }),
);

testEffect(
  "editor.number hides the line-number gutter",
  Effect.gen(function* () {
    const ioState = makeIo("/workspace", { "note.txt": ["contents"] });
    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    yield* mount(t, ioState, { file: "note.txt" }, sent, false);
    yield* waitForFrame(
      t,
      () => t.captureCharFrame().includes("contents"),
      "buffer loads the file",
    );
    expect(t.captureCharFrame()).not.toContain("   1contents");
  }),
);

testEffect(
  "editor.keyProfile cua shows a CUA status indicator",
  Effect.gen(function* () {
    const ioState = makeIo("/workspace", { "note.txt": ["hi"] });
    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const paneHost = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
    t.renderer.root.add(paneHost);
    const content = new BoxRenderable(t.renderer, {
      id: "pane-cua-content",
      position: "absolute",
      width: WIDTH - 2,
      height: HEIGHT - 2,
    });
    paneHost.add(content);
    const props: PaneViewProps = {
      sessionId: "",
      paneId: "pane-cua",
      paneType: "amux.editor",
      descriptor: { file: "note.txt" },
      width: () => WIDTH - 2,
      height: () => HEIGHT - 2,
      active: () => true,
      copyText: () => {},
      captureKeys: () => {},
    };
    const renderer = t.renderer as CliRenderer;
    const treeSitter = yield* buildTreeSitter();
    const dispose = _render(
      () => (
        <RendererContext.Provider value={renderer}>
          <EditorPane
            {...props}
            run={() => {}}
            spaceDir={ioState.spaceDir}
            lineNumbers={() => true}
            keyProfile={() => "cua"}
            io={makeTestEditorIo(ioState)}
            treeSitter={treeSitter}
          />
        </RendererContext.Provider>
      ),
      content,
    );
    yield* Effect.addFinalizer(() => Effect.sync(dispose));
    yield* waitForFrame(
      t,
      () => t.captureCharFrame().includes("-- CUA --"),
      "CUA status indicator",
    );
  }),
);

testEffect(
  "normal-mode colon opens the shared command picker",
  Effect.gen(function* () {
    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const { press } = yield* mount(t, makeIo("/workspace"), {}, sent);
    press(keystroke(":"));
    yield* waitForFrame(t, () => t.captureCharFrame().includes(":edit"), "command picker");
    const frame = t.captureCharFrame();
    expect(frame).toContain(":write");
    expect(frame).toContain(":quit!");
  }),
);

testEffect(
  ":e reads a file and records it in the pane descriptor, once",
  Effect.gen(function* () {
    const dir = "/workspace";
    const file = `${dir}/note.txt`;
    const ioState = makeIo(dir, { "note.txt": ["hello", "world"] });

    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const { press } = yield* mount(t, ioState, {}, sent);
    yield* Effect.promise(() => t.renderOnce());
    const handler = press;

    // :e /abs/path — command mode collects the path, Enter fulfils the open
    // request, which reads the file and then records it in the descriptor.
    handler!(keystroke(":"));
    for (const ch of `e ${file}`) handler!(keystroke(ch));
    handler!(keystroke("return"));
    yield* Effect.promise(() =>
      waitFor(() => tagged(sent, "pane.set-descriptor").length > 0, "descriptor write after :e"),
    );
    const descriptorWrite: unknown = tagged(sent, "pane.set-descriptor")[0];
    expect(descriptorWrite).toEqual({
      _tag: "pane.set-descriptor",
      pane: "pane-1",
      descriptor: { file },
    });
    // Exactly one descriptor write: later keystrokes must not resend it.
    handler!(keystroke("j"));
    handler!(keystroke("k"));
    yield* Effect.promise(() => t.renderOnce());
    yield* Effect.sleep("20 millis");
    expect(tagged(sent, "pane.set-descriptor")).toHaveLength(1);
    // And the buffer shows the file.
    yield* waitForFrame(t, () => t.captureCharFrame().includes("hello"), "buffer renders the file");
  }),
);

testEffect(
  "a remount renders the descriptor's file",
  Effect.gen(function* () {
    const ioState = makeIo("/workspace", { "note.txt": ["remounted"] });

    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    yield* mount(t, ioState, { file: "note.txt" }, sent);
    yield* waitForFrame(
      t,
      () => t.captureCharFrame().includes("remounted"),
      "remount renders the file",
    );
    // A mount whose descriptor already names the file sends nothing.
    yield* Effect.sleep("20 millis");
    expect(tagged(sent, "pane.set-descriptor")).toHaveLength(0);
  }),
);

testEffect(
  ":q closes the pane through the command queue, once",
  Effect.gen(function* () {
    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const { press, controller } = yield* mount(t, makeIo("/workspace"), {}, sent);
    yield* Effect.promise(() => t.renderOnce());
    const handler = press;

    handler(keystroke(":"));
    handler(keystroke("q"));
    // Picker is up for `:q` — Enter must expand + execute, not stall.
    yield* waitForFrame(
      t,
      () => controller()?.completionVisible() === true,
      "command picker visible for :q",
    );
    handler(keystroke("return"));
    yield* Effect.promise(() =>
      waitFor(() => tagged(sent, "pane.close").length > 0, "pane.close after :q"),
    );
    expect(tagged(sent, "pane.close")).toHaveLength(1);
  }),
);

test("command picker Enter expands the match then dispatches", () => {
  const calls: string[] = [];
  const controller = {
    completionVisible: () => true,
    moveCompletion: () => {},
    chooseCompletion: () => {
      calls.push("choose");
    },
    requestFileCompletion: () => false,
  };
  const handled = handleCommandPickerKey(controller, keystroke("return"), () => {
    calls.push("dispatch");
    return true;
  });
  expect(handled).toBe(true);
  expect(calls).toEqual(["choose", "dispatch"]);
});

test("command picker Tab arms file completion when the line is a file arg", () => {
  let armed = false;
  const handled = handleCommandPickerKey(
    {
      completionVisible: () => false,
      moveCompletion: () => {},
      chooseCompletion: () => {},
      requestFileCompletion: () => {
        armed = true;
        return true;
      },
    },
    keystroke("tab"),
    () => false,
  );
  expect(handled).toBe(true);
  expect(armed).toBe(true);
});

test("command picker is a no-op when hidden", () => {
  const handled = handleCommandPickerKey(
    {
      completionVisible: () => false,
      moveCompletion: () => {},
      chooseCompletion: () => {
        throw new Error("must not choose");
      },
      requestFileCompletion: () => false,
    },
    keystroke("return"),
    () => {
      throw new Error("must not dispatch via picker");
    },
  );
  expect(handled).toBeNull();
});

testEffect(
  ":w writes the buffer back to the open file",
  Effect.gen(function* () {
    const dir = "/workspace";
    const file = `${dir}/note.txt`;
    const ioState = makeIo(dir, { "note.txt": ["before"] });

    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const { press } = yield* mount(t, ioState, { file: "note.txt" }, sent);
    yield* waitForFrame(t, () => t.captureCharFrame().includes("before"), "buffer loads the file");
    const handler = press;

    // Append a line, then :w.
    handler(keystroke("o"));
    for (const ch of "after") handler(keystroke(ch));
    handler(keystroke("escape"));
    handler(keystroke(":"));
    handler(keystroke("w"));
    handler(keystroke("return"));
    yield* Effect.promise(() =>
      waitFor(
        () => ioState.files.get(file)?.includes("after") === true,
        "in-memory io has the new line after :w",
      ),
    );
  }),
);

testEffect(
  "a failed :e preserves unsaved text and reports the read error",
  Effect.gen(function* () {
    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const { press } = yield* mount(t, makeIo("/workspace"), {}, sent);
    yield* Effect.promise(() => t.renderOnce());
    const handler = press;
    for (const name of ["i", ..."keep me", "escape", ":", ..."e missing.txt", "return"]) {
      handler(keystroke(name));
    }
    yield* waitForFrame(
      t,
      () => t.captureCharFrame().includes("read failed"),
      "read error is visible",
    );
    expect(t.captureCharFrame()).toContain("keep me");
    expect(sent).toEqual([]);
  }),
);

testEffect(
  "keys entered after :e apply to the loaded file in order",
  Effect.gen(function* () {
    const ioState = makeIo("/workspace", { "note.txt": ["original"] });
    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const { press } = yield* mount(t, ioState, {}, sent);
    yield* Effect.promise(() => t.renderOnce());
    const handler = press;
    for (const name of [":", ..."e note.txt", "return", "i", ..."new ", "escape"]) {
      handler(keystroke(name));
    }
    yield* waitForFrame(
      t,
      () => t.captureCharFrame().includes("new original"),
      "queued keys edit loaded file",
    );
  }),
);

testEffect(
  "a completed save does not clear edits typed after :w",
  Effect.gen(function* () {
    const dir = "/workspace";
    const file = `${dir}/note.txt`;
    const ioState = makeIo(dir, { "note.txt": ["original"] });
    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const { press } = yield* mount(t, ioState, { file: "note.txt" }, sent);
    yield* waitForFrame(t, () => t.captureCharFrame().includes("original"), "initial load");
    const handler = press;
    for (const name of [":", "w", "return", "i", "x", "escape"]) handler(keystroke(name));
    yield* waitForFrame(t, () => t.captureCharFrame().includes("xoriginal"), "new edit is visible");
    for (const name of [":", "q", "return"]) handler(keystroke(name));
    yield* waitForFrame(
      t,
      () => t.captureCharFrame().includes("no write since"),
      "unsaved edit blocks quit",
    );
    expect(ioState.files.get(file)).toEqual(["original"]);
    expect(sent).toEqual([]);
  }),
);

testEffect(
  "a typescript file renders tree-sitter colors through the real client",
  Effect.gen(function* () {
    const line = 'import x from "y";';
    const ioState = makeIo("/workspace", { "main.ts": [line] });
    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const highlight = yield* makeHighlightProvider();
    const { press } = yield* mount(t, ioState, { file: "main.ts" }, sent, true, highlight);

    // The worker parses off-fiber, so wait for the mauve keyword span rather
    // than the frame the open triggered. `from` is asserted instead of the
    // line-leading `import`: the cursor overlay splits the char under the
    // cursor into its own span.
    const mauve = theme.mauve.toString();
    yield* waitForFrame(
      t,
      () =>
        t
          .captureSpans()
          .lines.some((row) =>
            row.spans.some((span) => span.text === "from" && span.fg.toString() === mauve),
          ),
      "keyword highlight arrives",
    );
    // Styled chunks still read as the full line.
    const rendered = t
      .captureSpans()
      .lines.map((row) => row.spans.map((span) => span.text).join(""))
      .join("\n");
    expect(rendered).toContain(line);

    // Edits re-highlight: open a line below, type a keyword, and wait for
    // its mauve span. This exercises the drainer update path end to end.
    // `cons` is asserted instead of `const`: the cursor overlay splits the
    // char under the cursor into its own span.
    press(keystroke("o"));
    for (const ch of "const") press(keystroke(ch));
    press(keystroke("escape"));
    yield* waitForFrame(
      t,
      () =>
        t
          .captureSpans()
          .lines.some((row) =>
            row.spans.some((span) => span.text === "cons" && span.fg.toString() === mauve),
          ),
      "edit re-highlights",
    );
  }),
);

testEffect(
  "opening a TSX buffer loads grammar so dit works without ensureGrammar",
  Effect.gen(function* () {
    const ioState = makeIo("/workspace", {
      "Widget.tsx": ["<div>", "  hello", "</div>"],
    });
    const sent: SentCommand[] = [];
    const { t } = yield* activate(sent);
    const { press, controller } = yield* mount(t, ioState, {}, sent);
    yield* Effect.promise(() => t.renderOnce());
    for (const name of [":", ..."e Widget.tsx", "return"]) {
      press(keystroke(name));
    }
    yield* waitForFrame(t, () => t.captureCharFrame().includes("hello"), "tsx buffer visible");
    yield* Effect.promise(() =>
      waitFor(() => controller()?.state().grammar !== null, "structure grammar loaded"),
    );
    for (const name of ["j", "w", "d", "i", "t"]) {
      press(keystroke(name));
    }
    yield* Effect.promise(() =>
      waitFor(() => {
        const state = controller()?.state();
        if (state === undefined) return false;
        // dit over a multiline jsx_element collapses to one line (same as
        // vim-core unit coverage for the inner range open-end → close-start).
        return linesOf(state.buffer).join("\n") === "<div></div>";
      }, "dit cleared tag inner"),
    );
  }),
);
