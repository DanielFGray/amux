/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js";
import { Effect } from "effect";
import type { PluginDefinition } from "../src/plugin/types.ts";

/** A minimal user plugin driven only by the public panel context. */
const statusBar: PluginDefinition = {
  id: "example.status-bar",
  apiVersion: "1",
  effect: (ctx) =>
    Effect.sync(() => {
      ctx.registerPanel({
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
};

export default statusBar;
