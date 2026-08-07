import { run, scopedSpaceSet } from "./harness.ts";
import { expect, describe, it, afterEach } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { workspaceEnv } from "./env.ts";
import { runtime } from "./options.ts";

describe("scroll", () => {
  const origGap = runtime["appearance.gap"];
  const disposers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    runtime["appearance.gap"] = origGap;
    for (const dispose of disposers.splice(0)) await dispose();
  });

  it("scroll up scrolls the pane's scrollback for a plain shell", async () => {
    const t = await createTestRenderer({ width: 30, height: 8 });
    const host = new BoxRenderable(t.renderer, { id: "host", flexGrow: 1 });
    t.renderer.root.add(host);
    const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer), host);
    disposers.push(async () => {
      await disposeSpaces();
      t.renderer.destroy();
    });

    const space = run(spaces.create("test", process.cwd()));
    const window = run(space.newWindow());
    const pane = run(window.init());
    pane.session.term.write(new TextEncoder().encode("line1\nline2\nline3\nline4\nline5\n"));

    let scrollCount = 0;
    const originalScrollBy = pane.session.scrollBy.bind(pane.session);
    pane.session.scrollBy = (rows: number) => {
      scrollCount += rows;
      originalScrollBy(rows);
    };

    await t.renderOnce();
    await t.mockMouse.scroll(
      Math.floor(pane.x + pane.width / 2),
      Math.floor(pane.y + pane.height / 2),
      "up",
    );
    await t.renderOnce();

    expect(scrollCount).toBe(-3);
    pane.session.scrollBy = originalScrollBy;
  });

  it("coalesces repeated output invalidations until the next frame", async () => {
    const t = await createTestRenderer({ width: 30, height: 8 });
    const host = new BoxRenderable(t.renderer, { id: "host", flexGrow: 1 });
    t.renderer.root.add(host);
    const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer), host);
    disposers.push(async () => {
      await disposeSpaces();
      t.renderer.destroy();
    });

    const space = run(spaces.create("test", process.cwd()));
    const window = run(space.newWindow());
    const pane = run(window.init());
    await t.renderOnce();
    const before = pane.rebuildCount;

    pane.write("input");
    pane.invalidate();
    pane.invalidate();
    pane.invalidate();
    await t.renderOnce();

    expect(pane.rebuildCount - before).toBe(1);
  });

  it("scroll wheel events reach the pane through nested boxes (App layout)", async () => {
    const t = await createTestRenderer({ width: 60, height: 15 });
    const outerRow = new BoxRenderable(t.renderer, { flexDirection: "row", flexGrow: 1 });
    const leftSidebar = new BoxRenderable(t.renderer, {
      width: 20,
      height: "100%",
      backgroundColor: "#1e1e2e",
    });
    const center = new BoxRenderable(t.renderer, { flexDirection: "column", flexGrow: 1 });
    const tabs = new BoxRenderable(t.renderer, { height: 1, backgroundColor: "#313244" });
    const paneArea = new BoxRenderable(t.renderer, { flexDirection: "row", flexGrow: 1 });
    const paneHost = new BoxRenderable(t.renderer, { flexDirection: "row", flexGrow: 1 });
    outerRow.add(leftSidebar);
    outerRow.add(center);
    center.add(tabs);
    center.add(paneArea);
    paneArea.add(paneHost);
    t.renderer.root.add(outerRow);

    const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer), paneHost);
    disposers.push(async () => {
      await disposeSpaces();
      t.renderer.destroy();
    });

    const space = run(spaces.create("test", process.cwd()));
    const window = run(space.newWindow());
    const pane = run(window.init());
    pane.session.term.write(new TextEncoder().encode("line1\nline2\nline3\nline4\nline5\n"));

    let scrollReached = false;
    const orig = (pane as any).onMouseEvent.bind(pane);
    (pane as any).onMouseEvent = function (this: any, event: any) {
      if (event.type === "scroll") scrollReached = true;
      orig(event);
    };
    await t.renderOnce();
    await t.mockMouse.scroll(
      Math.floor(pane.x + pane.width / 2),
      Math.floor(pane.y + pane.height / 2),
      "up",
    );
    await t.renderOnce();

    expect(scrollReached).toBe(true);
  });

  it("scroll events are forwarded to a mouse-reporting child", async () => {
    const t = await createTestRenderer({ width: 30, height: 8 });
    const host = new BoxRenderable(t.renderer, { id: "host", flexGrow: 1 });
    t.renderer.root.add(host);
    const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer), host);
    disposers.push(async () => {
      await disposeSpaces();
      t.renderer.destroy();
    });

    const space = run(spaces.create("test", process.cwd()));
    const window = run(space.newWindow());
    const pane = run(window.init());

    // Enable SGR mouse reporting on the terminal, simulating a full-screen child
    pane.session.term.write(new TextEncoder().encode("\x1b[?1002h\x1b[?1006h"));
    await t.renderOnce();

    let forwarded = "";
    const originalWrite = pane.session.write.bind(pane.session);
    pane.session.write = (data: string | Uint8Array) => {
      forwarded += typeof data === "string" ? data : new TextDecoder().decode(data);
      originalWrite(data);
    };

    await t.mockMouse.scroll(
      Math.floor(pane.x + pane.width / 2),
      Math.floor(pane.y + pane.height / 2),
      "up",
    );
    await t.renderOnce();

    expect(forwarded.length).toBeGreaterThan(0);
    pane.session.write = originalWrite;
  });

  it("renders an OSC title in the top border when gaps are enabled", async () => {
    const t = await createTestRenderer({ width: 40, height: 8 });
    const host = new BoxRenderable(t.renderer, { id: "host", flexGrow: 1 });
    t.renderer.root.add(host);
    const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer), host);
    disposers.push(async () => {
      await disposeSpaces();
      t.renderer.destroy();
    });

    runtime["appearance.gap"] = true;

    const space = run(spaces.create("test", process.cwd()));
    const window = run(space.newWindow());
    const pane = run(window.init());
    pane.session.term.write(new TextEncoder().encode("\x1b]0;myservice\x07"));
    await t.renderOnce();
    await t.renderOnce();

    const frame = t.captureCharFrame().split("\n");
    const topBorder = frame[pane.y]!;
    expect(topBorder.slice(pane.x, pane.x + pane.width)).toMatch(/┌ myservice ─+┐/);
  });

  it("no title in the border when gaps are disabled", async () => {
    const t = await createTestRenderer({ width: 40, height: 8 });
    const host = new BoxRenderable(t.renderer, { id: "host", flexGrow: 1 });
    t.renderer.root.add(host);
    const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer), host);
    disposers.push(async () => {
      await disposeSpaces();
      t.renderer.destroy();
    });

    runtime["appearance.gap"] = false;

    const space = run(spaces.create("test", process.cwd()));
    const window = run(space.newWindow());
    const pane = run(window.init());
    pane.session.term.write(new TextEncoder().encode("\x1b]0;myservice\x07"));
    await t.renderOnce();
    await t.renderOnce();

    const frame = t.captureCharFrame().split("\n");
    const topBorder = frame[pane.y]!;
    expect(topBorder.slice(pane.x, pane.x + pane.width)).not.toMatch(/myservice/);
  });

  it("no title when pane is too narrow", async () => {
    const t = await createTestRenderer({ width: 13, height: 8 });
    const host = new BoxRenderable(t.renderer, { id: "host", flexGrow: 1 });
    t.renderer.root.add(host);
    const { spaces, dispose: disposeSpaces } = scopedSpaceSet(workspaceEnv(t.renderer), host);
    disposers.push(async () => {
      await disposeSpaces();
      t.renderer.destroy();
    });

    runtime["appearance.gap"] = true;

    const space = run(spaces.create("test", process.cwd()));
    const window = run(space.newWindow());
    const pane = run(window.init());
    pane.session.term.write(new TextEncoder().encode("\x1b]0;need14chars\x07"));
    await t.renderOnce();
    await t.renderOnce();

    const frame = t.captureCharFrame().split("\n");
    const topBorder = frame[pane.y]!;
    expect(topBorder.slice(pane.x, pane.x + pane.width)).not.toMatch(/need14chars/);
  });
});
