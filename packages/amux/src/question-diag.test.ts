/** @effect-diagnostics *:skip-file */
import { test } from "bun:test";
import { Effect } from "effect";
import { createTestRenderer } from "@opentui/core/testing";
import { createBindings } from "./bindings.ts";

test("diag: prefix? chord match variants", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    let fired = false;
    const bindings = createBindings(
      t.renderer,
      [
        {
          name: "app.help",
          key: "<prefix>?",
          desc: "help",
          group: "app",
          run: Effect.sync(() => {
            fired = true;
          }),
        },
      ],
      {
        keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
        onUnhandled: () => true,
        timeoutlenMs: 5000,
      },
    );
    console.log("strokes", bindings.chords.activeBindings().map((b) => b.strokes));
    t.mockInput.pressKey("a", { ctrl: true });
    await Bun.sleep(10);
    console.log("after prefix", bindings.chords.pending());
    // try ?
    t.mockInput.pressKey("?", { shift: true });
    await Bun.sleep(10);
    console.log("after ? shift", { fired, pending: bindings.chords.pending() });
    fired = false;
    bindings.chords.clear();
    t.mockInput.pressKey("a", { ctrl: true });
    await Bun.sleep(10);
    t.mockInput.pressKey("/");
    await Bun.sleep(10);
    console.log("after /", { fired, pending: bindings.chords.pending() });
    fired = false;
    bindings.chords.clear();
    t.mockInput.pressKey("a", { ctrl: true });
    await Bun.sleep(10);
    t.mockInput.pressKey("/", { shift: true });
    await Bun.sleep(10);
    console.log("after shift+/", { fired, pending: bindings.chords.pending() });
    fired = false;
    bindings.chords.clear();
    t.mockInput.pressKey("a", { ctrl: true });
    await Bun.sleep(10);
    t.mockInput.pressKey("?");
    await Bun.sleep(10);
    console.log("after bare ?", { fired, pending: bindings.chords.pending() });
  } finally {
    t.renderer.destroy();
  }
});
