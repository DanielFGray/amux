import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import {
  CliCommandsTag,
  ForeignHarnessAdaptersTag,
  ForeignHarnessHookError,
  definePlugin,
  registerForeignHarnessAdapter,
  type ForeignHarnessAdapter,
  type PluginDefinition,
} from "@danielfgray/amux";
import { adapters } from "./adapters/index.ts";

const usage = (): string =>
  `usage: amux agent-hook <${adapters.map((a) => a.id).join("|")}> <install|uninstall> --yes`;

const adapterById = (name: string | undefined): ForeignHarnessAdapter | undefined =>
  adapters.find((adapter) => adapter.id === name);

const handleAgentHook = Effect.fnUntraced(function* (argv: readonly string[]) {
  const [vendorName, action] = argv;
  const adapter = adapterById(vendorName);
  if (adapter === undefined || (action !== "install" && action !== "uninstall")) {
    process.stderr.write(usage() + "\n");
    return 2;
  }
  if (!argv.includes("--yes")) {
    process.stderr.write(
      `error: editing ${vendorName} config requires explicit consent; add --yes\n`,
    );
    return 2;
  }
  const outcome: Effect.Effect<
    string | boolean,
    ForeignHarnessHookError | PlatformError,
    FileSystem.FileSystem
  > = action === "install" ? adapter.hooks.install() : adapter.hooks.uninstall();
  return yield* outcome.pipe(
    Effect.provide(BunFileSystem.layer),
    Effect.map((result) => {
      if (action === "install") process.stdout.write(`installed ${vendorName} hook at ${result}\n`);
      else
        process.stdout.write(
          result ? `removed ${vendorName} hook\n` : `no ${vendorName} hook installed\n`,
        );
      return 0;
    }),
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(`error: ${String(error)}\n`);
        return 1;
      }),
    ),
  );
});

/**
 * CLI + adapter registration for foreign PTY harness continuity (hooks install
 * and the resume table). Separate from provider auth: this is about agents that
 * run as ordinary pane programs.
 */
export const agentContinuityCliPlugin: PluginDefinition = definePlugin({
  id: "amux.agent-continuity.cli",
  inject: [CliCommandsTag, ForeignHarnessAdaptersTag],
  effect: () =>
    Effect.gen(function* () {
      for (const adapter of adapters) yield* registerForeignHarnessAdapter(adapter);
      const cliCommands = yield* CliCommandsTag;
      yield* cliCommands.register({
        name: "agent-hook",
        description: "install or remove a foreign agent harness self-report hook",
        handler: handleAgentHook,
      });
    }),
});

export default agentContinuityCliPlugin;
