/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- driving a real Solid view with per-keystroke key flow belongs to OpenTUI/Solid's lifecycle. */
import { afterEach, expect, test } from "bun:test";
import { Effect, Exit, Option, Scope } from "effect";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { RendererContext, _render } from "@opentui/solid";
import { testPluginEnvironment, testPanelContext, waitFor } from "@danielfgray/amux/testing";
import { OptionsTag, resolveOptions, SettingsTag } from "@danielfgray/amux";
import type { JsonValue, PaneViewProps } from "@danielfgray/amux";
import { createPluginHost, type PluginHost } from "@danielfgray/amux/plugin/host.ts";
import { editorPlugin } from "./plugin.tsx";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

const WIDTH = 60;
const HEIGHT = 16;

const keystroke = (name: string): KeyEvent =>
  ({ raw: name, sequence: name, name, eventType: "press" }) as KeyEvent;

type Registries = ReturnType<typeof testPluginEnvironment>["registries"];

/** Activate the editor plugin in a test environment: a renderer, a panel
 *  stub whose run records the commands the editor sends, and a live plugin
 *  host running the registry entries plus the editor. */
async function activate(
  sent: string[],
  dir: string,
  seenBindings: string[] = [],
  lineNumbers = true,
) {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const panel = testPanelContext({
    snapshot: () =>
      ({
        revision: 0,
        spaces: [{ id: "space-a", dir, name: "test", windows: [] }],
        state: { activeSpace: "space-a", nextSpace: 2 },
      }) as never,
    options: () => ({ ...resolveOptions({}), "editor.number": lineNumbers }),
    // Pure at construction like the real panel.run: the push happens when
    // the returned Effect runs, not when the command value is built.
    run: (value) =>
      Effect.as(
        Effect.sync(() => {
          sent.push(JSON.stringify(value));
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
  const scope = Scope.makeUnsafe();
  const host: PluginHost = await Effect.runPromise(
    Scope.provide(
      Effect.gen(function* () {
        const host = yield* createPluginHost(environment);
        const refused = yield* host.reconcile([...environment.registryEntries, editorPlugin]);
        expect(refused).toEqual([]);
        return host;
      }).pipe(Effect.provideService(Scope.Scope, scope)),
      scope,
    ),
  );
  disposers.push(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await Bun.sleep(50);
    t.renderer.destroy();
  });
  // Registration rides a forked activation fiber; wait for its side effect
  // rather than sleeping a fixed beat.
  await waitFor(
    () => environment.registries.sessionViews.has("amux.editor"),
    "editor view registration",
  );
  return { t, environment, host };
}

/** Mount the registered editor view in a content box and hand back the
 *  captureKeys handler the view registers on mount. */
function mount(
  t: Awaited<ReturnType<typeof createTestRenderer>>,
  environment: ReturnType<typeof testPluginEnvironment>,
  descriptor: JsonValue,
) {
  const host = new BoxRenderable(t.renderer, { id: "pane-host", flexGrow: 1 });
  t.renderer.root.add(host);
  const content = new BoxRenderable(t.renderer, {
    id: "pane-1-content",
    position: "absolute",
    width: WIDTH - 2,
    height: HEIGHT - 2,
  });
  host.add(content);
  let capture: ((event: KeyEvent) => boolean) | null = null;
  const props: PaneViewProps = {
    sessionId: "",
    paneId: "pane-1",
    paneType: "amux.editor",
    descriptor,
    width: () => WIDTH - 2,
    height: () => HEIGHT - 2,
    active: () => true,
    captureKeys: (handler) => {
      capture = handler;
    },
  };
  // Mount into the test renderer the way ComponentPane does — _render takes
  // the existing context rather than creating a second CliRenderer.
  const renderer = t.renderer as CliRenderer;
  const dispose = _render(
    () => (
      <RendererContext.Provider value={renderer}>
        {environment.registries.sessionViews.view(props)}
      </RendererContext.Provider>
    ),
    content,
  );
  disposers.push(async () => {
    dispose();
  });
  return { content, capture: () => capture };
}

function tempdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "amux-editor-"));
  disposers.push(async () => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("the editor plugin registers a view, a settings section, and a binding", async () => {
  const sent: string[] = [];
  const seenBindings: string[] = [];
  const { environment, host } = await activate(sent, tempdir(), seenBindings);
  expect(environment.registries.sessionViews.has("amux.editor")).toBe(true);
  const settings = Option.getOrThrow(host.get(SettingsTag)).all();
  expect(settings.some((section) => section.id === "amux.editor")).toBe(true);
  const options = Option.getOrThrow(host.get(OptionsTag));
  expect(options.all().map((entry) => entry.name)).toEqual(["editor.number"]);
  expect(seenBindings).toContain("editor.open");
  expect(sent).toEqual([]);
});

test("editor.number hides the line-number gutter", async () => {
  const dir = tempdir();
  const file = join(dir, "note.txt");
  writeFileSync(file, "contents\n");
  const sent: string[] = [];
  const { t, environment } = await activate(sent, dir, [], false);
  mount(t, environment, { file });
  await t.renderOnce();
  await waitFor(() => t.captureCharFrame().includes("contents"), "buffer loads the file");
  expect(t.captureCharFrame()).not.toContain("   1contents");
});

test(":e reads a file and records it in the pane descriptor, once", async () => {
  const dir = tempdir();
  const file = join(dir, "note.txt");
  writeFileSync(file, "hello\nworld\n");

  const sent: string[] = [];
  const { t, environment } = await activate(sent, dir);
  const { capture } = mount(t, environment, {});
  await t.renderOnce();
  const handler = capture();
  expect(handler).not.toBeNull();

  // :e /abs/path — command mode collects the path, Enter fulfils the open
  // request, which reads the file and then records it in the descriptor.
  handler!(keystroke(":"));
  for (const ch of `e ${file}`) handler!(keystroke(ch));
  handler!(keystroke("return"));
  await waitFor(
    () => sent.some((value) => value.includes('"pane.set-descriptor"')),
    "descriptor write after :e",
  );
  expect(sent.some((value) => value.includes(file))).toBe(true);
  // Exactly one descriptor write: later keystrokes must not resend it.
  handler!(keystroke("j"));
  handler!(keystroke("k"));
  await t.renderOnce();
  await Bun.sleep(20);
  expect(sent.filter((value) => value.includes('"pane.set-descriptor"'))).toHaveLength(1);
  // And the buffer shows the file.
  await waitFor(() => t.captureCharFrame().includes("hello"), "buffer renders the file");
});

test("a remount renders the descriptor's file", async () => {
  const dir = tempdir();
  const file = join(dir, "note.txt");
  writeFileSync(file, "remounted\n");

  const sent: string[] = [];
  const { t, environment } = await activate(sent, dir);
  mount(t, environment, { file });
  await t.renderOnce();
  await waitFor(() => t.captureCharFrame().includes("remounted"), "remount renders the file");
  // A mount whose descriptor already names the file sends nothing.
  await Bun.sleep(20);
  expect(sent.filter((value) => value.includes('"pane.set-descriptor"'))).toHaveLength(0);
});

test(":q closes the pane through the command queue, once", async () => {
  const sent: string[] = [];
  const { t, environment } = await activate(sent, tempdir());
  const { capture } = mount(t, environment, {});
  await t.renderOnce();
  const handler = capture()!;

  handler(keystroke(":"));
  handler(keystroke("q"));
  handler(keystroke("return"));
  await waitFor(() => sent.some((value) => value.includes('"pane.close"')), "pane.close after :q");
  expect(sent.filter((value) => value.includes('"pane.close"'))).toHaveLength(1);
});

test(":w writes the buffer back to the open file", async () => {
  const dir = tempdir();
  const file = join(dir, "note.txt");
  writeFileSync(file, "before\n");

  const sent: string[] = [];
  const { t, environment } = await activate(sent, dir);
  const { capture } = mount(t, environment, { file });
  await t.renderOnce();
  await waitFor(() => t.captureCharFrame().includes("before"), "buffer loads the file");
  const handler = capture()!;

  // Append a line, then :w.
  handler(keystroke("o"));
  for (const ch of "after") handler(keystroke(ch));
  handler(keystroke("escape"));
  handler(keystroke(":"));
  handler(keystroke("w"));
  handler(keystroke("return"));
  await waitFor(
    () =>
      Bun.file(file)
        .text()
        .then((text) => text.includes("after")),
    "file contains the new line after :w",
  );
});

test("a failed :e preserves unsaved text and reports the read error", async () => {
  const dir = tempdir();
  const sent: string[] = [];
  const { t, environment } = await activate(sent, dir);
  const { capture } = mount(t, environment, {});
  await t.renderOnce();
  const handler = capture()!;
  for (const name of ["i", ..."keep me", "escape", ":", ..."e missing.txt", "return"]) {
    handler(keystroke(name));
  }
  await waitFor(() => t.captureCharFrame().includes("read failed"), "read error is visible");
  expect(t.captureCharFrame()).toContain("keep me");
  expect(sent).toEqual([]);
});

test("keys entered after :e apply to the loaded file in order", async () => {
  const dir = tempdir();
  writeFileSync(join(dir, "note.txt"), "original\n");
  const sent: string[] = [];
  const { t, environment } = await activate(sent, dir);
  const { capture } = mount(t, environment, {});
  await t.renderOnce();
  const handler = capture()!;
  for (const name of [":", ..."e note.txt", "return", "i", ..."new ", "escape"]) {
    handler(keystroke(name));
  }
  await waitFor(
    () => t.captureCharFrame().includes("new original"),
    "queued keys edit loaded file",
  );
});

test("a completed save does not clear edits typed after :w", async () => {
  const dir = tempdir();
  const file = join(dir, "note.txt");
  writeFileSync(file, "original\n");
  const sent: string[] = [];
  const { t, environment } = await activate(sent, dir);
  const { capture } = mount(t, environment, { file });
  await t.renderOnce();
  await waitFor(() => t.captureCharFrame().includes("original"), "initial load");
  const handler = capture()!;
  for (const name of [":", "w", "return", "i", "x", "escape"]) handler(keystroke(name));
  await waitFor(() => t.captureCharFrame().includes("xoriginal"), "new edit is visible");
  for (const name of [":", "q", "return"]) handler(keystroke(name));
  await waitFor(() => t.captureCharFrame().includes("no write since"), "unsaved edit blocks quit");
  expect(await Bun.file(file).text()).toBe("original\n");
  expect(sent).toEqual([]);
});
