/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js";
import { Effect } from "effect";
import { definePlugin, PanelTag, SlotsTag, type PluginDefinition } from "amux";

/** A minimal user plugin driven only by the public panel context. */
const statusBar: PluginDefinition = definePlugin({
  id: "example.status-bar",
  inject: [PanelTag, SlotsTag],
  effect: () =>
    Effect.gen(function* () {
      const slots = yield* SlotsTag;
      const panel = yield* PanelTag;
      yield* slots.register({
        slot: "bottom.app",
        occupant: {
          id: "example.status-bar.panel",
          title: "status",
          size: () => 1,
          component: () => {
            const label = createMemo(() => {
              const snapshot = panel.snapshot();
              const active = snapshot.state.activeSpace;
              const space = snapshot.spaces.find((item) => item.id === active);
              const shell = panel.options()["behaviour.shell"] || "$SHELL";
              return ` ${space?.name ?? "no space"} | ${shell} `;
            });
            return <text style={{ height: 1, fg: "#cdd6f4", bg: "#313244" }}>{label()}</text>;
          },
        },
      });
    }),
});

export default statusBar;
