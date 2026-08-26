/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js";
import { Effect } from "effect";
import { definePlugin, type PluginDefinition } from "../packages/amux/src/plugin/types.ts";
import { RegionsTag } from "../packages/amux/src/plugin/services.ts";

/** A minimal user plugin driven only by the public panel context. */
const statusBar: PluginDefinition = definePlugin({
  id: "example.status-bar",
  apiVersion: "1",
  inject: [RegionsTag],
  effect: (ctx) =>
    Effect.gen(function* () {
      const regions = yield* RegionsTag;
      yield* regions.register({
        id: "example.status-bar.panel",
        region: "bottom",
        anchor: "app",
        title: "status",
        size: () => 1,
        component: () => {
          const label = createMemo(() => {
            const snapshot = ctx.panel.snapshot();
            const active = snapshot.state.activeSpace;
            const space = snapshot.spaces.find((item) => item.id === active);
            const shell = ctx.panel.options()["behaviour.shell"] || "$SHELL";
            return ` ${space?.name ?? "no space"} | ${shell} `;
          });
          return <text style={{ height: 1, fg: "#cdd6f4", bg: "#313244" }}>{label()}</text>;
        },
      });
    }),
});

export default statusBar;
