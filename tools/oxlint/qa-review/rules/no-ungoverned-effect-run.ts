import { defineRule } from "@oxlint/plugins";

/**
 * Files allowed to call `Effect.run*` directly: process entry points (which
 * own the one root fiber the rest of the client hangs off), the pty-reader
 * worker (a Worker thread with no access to the client's runtime), and the
 * bridge/primitive modules that exist specifically to give a synchronous
 * caller (a render callback, a Solid component) a governed escape hatch —
 * see ep-6e69df Phase 5's "one ManagedRuntime at boot" decision.
 */
const ALLOWED_PATH_SUBSTRINGS = [
  "/src/main.tsx",
  "/src/daemon-main.ts",
  "/src/cli.ts",
  "/src/session-cli.ts",
  "/src/pty-reader.worker.ts",
  "/src/bridge.ts",
  "/src/effect/SolidRuntime.ts",
  "/src/effect/node-path.ts",
  "/src/env.ts",
  "/src/test-effect.ts",
  "/src/test-wait.ts",
];

function isAllowed(filename: string): boolean {
  if (filename.includes(".test.")) return true;
  return ALLOWED_PATH_SUBSTRINGS.some((substring) => filename.includes(substring));
}

const RUN_METHODS = new Set(["runSync", "runSyncExit", "runFork", "runPromise", "runPromiseExit"]);

/**
 * Disallow calling Effect's unbound run* functions outside the documented
 * list of entry points.
 *
 * Deliberately a warning, not an error: ep-6e69df Phase 5 (ts-9076fd) found
 * ~50-60 real sites this flags today — attach.ts, session-handle.ts,
 * backend.ts and a few more, all plain synchronous classes using Effect.run*
 * as a synchronous utility (Clock.currentTimeMillis, Random.next,
 * Deferred.succeed) rather than as a lifetime escape hatch. Auditing and
 * converting those, and building the "one root ManagedRuntime, child
 * runtimes per plugin" architecture that would let them thread a runtime
 * instead, is unfinished follow-up work, not something this rule can assume
 * is already done. It exists so that work is not forgotten and a genuinely
 * new ungoverned call site still shows up in review — promote it to "error"
 * once that audit lands and the allowlist above reflects reality.
 */
export const noUngovernedEffectRunRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Effect.runSync/runFork/runPromise/runPromiseExit outside process entry points and the bridge modules that exist to host them. Everywhere else, thread the ambient runtime or Effect context through instead (runSyncWith/runForkWith/runPromiseWith, or ordinary yield*).",
    },
    messages: {
      ungovernedRun:
        "{{method}} runs on Effect's default runtime, invisible to whatever Layer/Scope the caller is actually inside. Thread the ambient runtime through ({{method}}With) or yield* the effect instead — see ep-6e69df Phase 5 (ts-9076fd).",
    },
  },
  create(context) {
    if (isAllowed(context.filename)) return {};
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.object.name === "Effect" &&
          callee.property.type === "Identifier" &&
          RUN_METHODS.has(callee.property.name)
        ) {
          context.report({
            node,
            messageId: "ungovernedRun",
            data: { method: callee.property.name },
          });
        }
      },
    };
  },
});
