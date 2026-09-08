/** @effect-diagnostics *:skip-file -- the OpenTUI renderer is an async test boundary. */
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Effect } from "effect";
import { createSignal } from "solid-js";
import {
  BindingsTag,
  ContextsTag,
  OptionsTag,
  PanelTag,
  resolveOptions,
  type CommandSpec,
  type ContextSpec,
  type PluginDefinition,
} from "@danielfgray/amux";
import { createBindings } from "../../amux/src/bindings.ts";
import { resolveUnhandled } from "../../amux/src/key-context.ts";
import { createPluginHost } from "@danielfgray/amux/plugin/host.ts";
import { testPanelContext, testPluginEnvironment } from "@danielfgray/amux/testing";
import modalPlugin from "./index.ts";

test("enters with the configured leader, retires one-shot commands, and consumes unknown keys", async () => {
  const t = await createTestRenderer({ width: 40, height: 10 });
  try {
    const [options, setOptions] = createSignal({ ...resolveOptions({}), "modal.vimMode": false });
    const bindings: CommandSpec[] = [];
    const contexts: ContextSpec[] = [];
    const runs: string[] = [];
    const environment = testPluginEnvironment(t.renderer, {
      panel: testPanelContext({
        options,
        run: (value) => {
          return Effect.sync(() => {
            runs.push(value._tag);
            return testPanelContext().snapshot();
          });
        },
      }),
      registries: {
        bindings: (_owner, binding) => {
          bindings.push(binding);
          return () => bindings.splice(bindings.indexOf(binding), 1);
        },
        contexts: (_owner, context) => {
          contexts.push(context);
          return () => contexts.splice(contexts.indexOf(context), 1);
        },
      },
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* createPluginHost(environment);
          for (const tag of [BindingsTag, ContextsTag, OptionsTag, PanelTag]) {
            const provider = environment.registryEntries.find((entry) =>
              entry.provide?.some((provided) => provided.key === tag.key),
            ) as PluginDefinition;
            yield* Effect.orDie(host.add(provider));
          }
          yield* Effect.orDie(host.add(modalPlugin));
          const amux = contexts[0]!;
          let paneKeys = 0;
          createBindings(t.renderer, bindings, {
            keys: { leader: "ctrl+b", bindings: {} },
            onUnhandled: (event) => {
              if (resolveUnhandled([amux], event)) return true;
              paneKeys++;
              return true;
            },
          });

          t.mockInput.pressKey("b", { ctrl: true });
          expect(amux.active()).toBe(true);
          t.mockInput.pressKey("h");
          expect(runs).toEqual(["pane.resize"]);
          expect(amux.active()).toBe(false);

          t.mockInput.pressKey("b", { ctrl: true });
          t.mockInput.pressKey("x");
          expect(amux.active()).toBe(false);
          expect(paneKeys).toBe(0);
          t.mockInput.pressKey("x");
          expect(paneKeys).toBe(1);

          setOptions((current) => ({ ...current, "modal.vimMode": true }));
          t.mockInput.pressKey("b", { ctrl: true });
          t.mockInput.pressKey("h");
          expect(amux.active()).toBe(true);
          t.mockInput.pressKey("i");
          expect(amux.active()).toBe(false);

          yield* host.remove(modalPlugin.id);
          expect(bindings).toEqual([]);
          expect(contexts).toEqual([]);
        }),
      ),
    );
  } finally {
    t.renderer.destroy();
  }
});
