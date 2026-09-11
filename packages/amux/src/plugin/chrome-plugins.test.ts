import { expect } from "bun:test";
import { Effect } from "effect";
import { fileURLToPath } from "node:url";
import { hotImport, pluginRoot } from "./hot.ts";
import { testEffect } from "../test-effect.ts";

testEffect("bundled settings and commands PluginEntry sources hotImport", () =>
  Effect.gen(function* () {
    const settingsSource = new URL("../plugins/settings.tsx", import.meta.url);
    const commandsSource = new URL("../plugins/commands.tsx", import.meta.url);

    expect(pluginRoot(settingsSource)).toBe(
      `${fileURLToPath(settingsSource).replace(/\.tsx$/, "")}/`,
    );
    expect(pluginRoot(commandsSource)).toBe(
      `${fileURLToPath(commandsSource).replace(/\.tsx$/, "")}/`,
    );

    const settings = yield* hotImport(settingsSource);
    const commands = yield* hotImport(commandsSource);
    expect(settings.id).toBe("amux.settings");
    expect(commands.id).toBe("amux.commands");
  }),
);
