/**
 * What a workspace needs to exist, as context rather than as parameters.
 *
 * Three values were threaded four levels deep — SpaceSet to Space to Window to
 * Pane — and none of them varies within a process. Carrying them as a Context
 * means a Space asks for what it needs instead of being handed it by whoever
 * happened to construct it, and adding a fourth such value later costs one Tag
 * rather than an edit to every signature between here and the leaf.
 *
 * Kept in its own module because space.ts and window.ts both need it and
 * already import each other.
 */

import { Context, Effect } from "effect";
import type { RenderContext } from "@opentui/core";
import { localPty, type SessionBackendFactory } from "./backend.ts";
import type { PaneView } from "./component-pane.tsx";
import { resolveOptions, type Options } from "./options.ts";

/** The renderer everything in a workspace draws into. No default: there is no
 *  sensible stand-in for a renderer, and a missing one should not be silently
 *  papered over with a fake that renders nowhere. */
export class RenderCtx extends Context.Service<RenderCtx, RenderContext>()("RenderCtx") {}

/** Command a new agent runs. Comes from config; bash is what the config
 *  defaults to when the user has expressed no preference and $SHELL is unset. */
export const Shell = Context.Reference<string[]>("Shell", {
  defaultValue: (): string[] => ["bash"],
});

/**
 * Where agents started in this workspace get their processes.
 *
 * Previously an optional parameter at every level, so "run it locally" and
 * "nobody told me" were the same undefined. As a Reference the two separate:
 * the default IS the local PTY, stated once, and a daemon-backed workspace
 * provides the other one deliberately.
 *
 * This is the workspace-wide choice. An individual agent can still be given its
 * own backend — restore does exactly that, handing a tombstone one that starts
 * nothing — and that override stays where it is, an argument to the one agent
 * it concerns rather than a default anything inherits.
 */
export const Backend = Context.Reference<SessionBackendFactory>("Backend", {
  defaultValue: (): SessionBackendFactory => localPty,
});

/**
 * What draws a component session's pane.
 *
 * The counterpart of Backend on the other axis: Backend says where a session's
 * content comes from, this says what turns that content into cells. A pty needs
 * no entry here because an emulator and a grid are the only answer; a component
 * is whatever the app decided to mount.
 *
 * Null is the default and a real state — a workspace that registered no view (a
 * test, a headless client) draws such a pane as an empty frame rather than
 * failing, exactly as it draws an unavailable component backend as no pane at all.
 */
export const PaneViews = Context.Reference<PaneView | null>("PaneViews", {
  defaultValue: (): PaneView | null => null,
});

/**
 * Option values a pane, window or divider reads imperatively at the point of
 * use — pane borders, wheel scrolling — with no path back to the app's
 * reactive graph. One mutable object per workspace: whoever holds the
 * reference sees every later write, because there is exactly one writer (the
 * app's reactive effect) mutating it in place, and every reader (Pane,
 * Window, Divider) captures the same instance rather than importing a
 * process-wide global (see options.ts's applyOptions).
 */
export const OptionsRuntime = Context.Reference<Options>("OptionsRuntime", {
  defaultValue: (): Options => resolveOptions({}),
});

/**
 * The ambient Effect context the process's root fiber runs in — whatever
 * Layer main.tsx or daemon-main.ts provided at boot, captured once there and
 * threaded down. Synchronous classes built outside any fiber (SessionHandle,
 * a session's backend, ...) use it to run an Effect on the runtime the
 * process actually booted instead of Effect's ambient default — see
 * ep-6e69df Phase 5.
 *
 * Defaults to capturing whatever is ambient wherever nothing else was
 * provided, which is the same default runtime every caller used implicitly
 * before this Reference existed — a test or harness that does not care can
 * still omit it.
 */
export const RootRuntime = Context.Reference<Context.Context<never>>("RootRuntime", {
  defaultValue: (): Context.Context<never> => Effect.runSync(Effect.context<never>()),
});

/** Everything a workspace reads out of its context. Shell, Backend,
 *  PaneViews, OptionsRuntime, RootRuntime are References, not Services —
 *  they always resolve to a default and so carry no identity in the
 *  requirement channel; only the renderer is actually required. */
export type WorkspaceEnv = RenderCtx;

/**
 * Build a workspace's context.
 *
 * The renderer is required and the rest are not, because the rest have defaults
 * and a renderer cannot. Omitting one here means "whatever the reference says",
 * which is the same thing omitting them has always meant — only now it is a
 * default with a name rather than an undefined travelling down four
 * constructors.
 */
export const workspaceEnv = (
  ctx: RenderContext,
  options: {
    shell?: string[];
    backend?: SessionBackendFactory;
    paneContent?: PaneView;
    options?: Options;
    runtime?: Context.Context<never>;
  } = {},
): Context.Context<WorkspaceEnv> => {
  let env = Context.make(RenderCtx, ctx) as Context.Context<WorkspaceEnv>;
  if (options.shell) env = Context.add(env, Shell, options.shell);
  if (options.backend) env = Context.add(env, Backend, options.backend);
  if (options.paneContent) env = Context.add(env, PaneViews, options.paneContent);
  if (options.options) env = Context.add(env, OptionsRuntime, options.options);
  if (options.runtime) env = Context.add(env, RootRuntime, options.runtime);
  return env;
};
