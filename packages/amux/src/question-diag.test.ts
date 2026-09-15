/** @effect-diagnostics *:skip-file */
import { test } from "bun:test";
import { Effect } from "effect";
import { createTestRenderer } from "@opentui/core/testing";
import { createBindings, pendingStrokeDisplay } from "./bindings.ts";

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
    const pending = () => bindings.keymap.getPendingSequence().map(pendingStrokeDisplay);
    t.mockInput.pressKey("a", { ctrl: true });
    await Bun.sleep(10);
    console.log("after prefix", pending());
    t.mockInput.pressKey("?", { shift: true });
    await Bun.sleep(10);
    console.log("after ? shift", { fired, pending: pending() });
    fired = false;
    bindings.keymap.clearPendingSequence();
    t.mockInput.pressKey("a", { ctrl: true });
    await Bun.sleep(10);
    t.mockInput.pressKey("/");
    await Bun.sleep(10);
    console.log("after /", { fired, pending: pending() });
    fired = false;
    bindings.keymap.clearPendingSequence();
    t.mockInput.pressKey("a", { ctrl: true });
    await Bun.sleep(10);
    t.mockInput.pressKey("/", { shift: true });
    await Bun.sleep(10);
    console.log("after shift+/", { fired, pending: pending() });
    fired = false;
    bindings.keymap.clearPendingSequence();
    t.mockInput.pressKey("a", { ctrl: true });
    await Bun.sleep(10);
    t.mockInput.pressKey("?");
    await Bun.sleep(10);
    console.log("after bare ?", { fired, pending: pending() });
  } finally {
    t.renderer.destroy();
  }
});
