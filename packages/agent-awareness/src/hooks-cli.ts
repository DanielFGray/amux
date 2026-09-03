import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { definePlugin, CliCommandsTag, type PluginDefinition } from "@danielfgray/amux";
import { AgentHookError, installOpencodeHook, uninstallOpencodeHook } from "./agent-hook.ts";

type HookAction = (
  home?: string,
) => Effect.Effect<string | boolean, AgentHookError | PlatformError, FileSystem.FileSystem>;

/**
 * Vendors this installer knows how to wire a hook into. Adding one is adding
 * an entry here, not a new branch in core's CLI dispatch — see
 * ARCHITECTURE.md for why core stays ignorant of what an agent is.
 */
const VENDORS = {
  opencode: { install: installOpencodeHook, uninstall: uninstallOpencodeHook },
} satisfies Readonly<
  Record<string, { readonly install: HookAction; readonly uninstall: HookAction }>
>;

const hasVendor = (name: string | undefined): name is keyof typeof VENDORS =>
  name !== undefined && Object.hasOwn(VENDORS, name);

const usage = `usage: amux agent-hook <${Object.keys(VENDORS).join("|")}> <install|uninstall> --yes`;

const handleAgentHook = (argv: readonly string[]): Effect.Effect<number> =>
  Effect.gen(function* () {
    const [vendorName, action] = argv;
    if (!hasVendor(vendorName) || (action !== "install" && action !== "uninstall")) {
      process.stderr.write(usage + "\n");
      return 2;
    }
    if (!argv.includes("--yes")) {
      process.stderr.write(
        `error: editing ${vendorName} config requires explicit consent; add --yes\n`,
      );
      return 2;
    }
    const vendor = VENDORS[vendorName];
    const outcome: Effect.Effect<
      string | boolean,
      AgentHookError | PlatformError,
      FileSystem.FileSystem
    > = action === "install" ? vendor.install() : vendor.uninstall();
    return yield* outcome.pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.map((result) => {
        if (action === "install")
          process.stdout.write(`installed ${vendorName} hook at ${result}\n`);
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
 * Installs and removes the harness hooks that let a coding agent self-report
 * its process state. CLI-only: it needs `CliCommandsTag` and nothing else, so
 * it runs from the headless host `amux` builds for a one-shot invocation —
 * unlike `amux.agent-awareness`, it never needs a client's `SessionStreamTag`
 * or `ProcessDisplayTag`, and bundling the two into one plugin would force
 * this installer to wait on tags it has no use for.
 */
export const agentHooksCliPlugin: PluginDefinition = definePlugin({
  id: "amux.agent-hooks-cli",
  inject: [CliCommandsTag],
  effect: () =>
    Effect.gen(function* () {
      const cliCommands = yield* CliCommandsTag;
      yield* cliCommands.register({
        name: "agent-hook",
        description: "install or remove a coding agent's self-report hook",
        handler: handleAgentHook,
      });
    }),
});

export default agentHooksCliPlugin;
