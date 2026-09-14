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
import type { FileSystem } from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import type { RenderContext } from "@opentui/core";
import { localPty, type SessionBackendFactory } from "./backend.ts";
import type { PaneView } from "./component-pane.tsx";
import type { LayoutKindRenderer } from "./layout-kinds.ts";
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
 * Layout-container kind renderers Window asks for while mounting. Default is
 * "no renderer" — Window falls back to a row/column flex box, the same as a
 * kind that has not registered yet (see scroll-restore tests).
 */
export type LayoutKindLookup = (kind: string) => LayoutKindRenderer | undefined;
export const LayoutKinds = Context.Reference<LayoutKindLookup>("LayoutKinds", {
  defaultValue: (): LayoutKindLookup => () => undefined,
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
 * Services the process root is typed to carry for governed `run*With` exits.
 *
 * Client `main.tsx` provides `BunFileSystem`; daemon main merges Path as well.
 * FileSystem is the floor so config saves and similar boundary crossings do
 * not re-`provide` the same layer at every call site.
 */
export type RootServices = FileSystem;

/** The ambient Effect context bag captured at process boot for `run*With`. */
export type RootRuntimeContext = Context.Context<RootServices>;

/**
 * The ambient Effect context the process's root fiber runs in — whatever
 * Layer main.tsx or daemon-main.ts provided at boot, captured once there and
 * threaded down. Synchronous classes built outside any fiber (SessionHandle,
 * a session's backend, ...) use it to run an Effect on the runtime the
 * process actually booted instead of Effect's ambient default — see
 * ep-6e69df Phase 5.
 *
 * Defaults to a Bun FileSystem context when nothing else was provided, so a
 * test or harness that omits an explicit runtime still has a real FS for
 * governed saves rather than an empty bag.
 */
export const RootRuntime = Context.Reference<RootRuntimeContext>("RootRuntime", {
  defaultValue: (): RootRuntimeContext => defaultRootRuntime(),
});

/** Standalone default for callers that build outside a fiber (SessionHandle, backends). */
export const defaultRootRuntime = (): RootRuntimeContext =>
  Effect.runSync(Effect.context<RootServices>().pipe(Effect.provide(BunFileSystem.layer)));

/**
 * Capture the ambient bag for `run*With` without putting `FileSystem` (or any
 * other RootService) into this Effect's requirement channel.
 *
 * `Effect.context<RootServices>()` both returns and *requires* those services,
 * which would force every daemon/attach/command surface to list FileSystem in
 * R. The runtime Context map still holds whatever the process root provided;
 * we merge the Bun FS default underneath so a test fiber with an empty bag
 * still has a real FileSystem for governed saves.
 */
export const captureRootRuntime: Effect.Effect<RootRuntimeContext> = Effect.map(
  Effect.context<never>(),
  (ambient) => Context.merge(defaultRootRuntime(), ambient as RootRuntimeContext),
);

/** Run an effect with RootServices from {@link captureRootRuntime} — drops
 *  per-call `Effect.provide(BunFileSystem.layer)` at config/save sites. */
export const provideRootServices = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, RootServices>> =>
  Effect.flatMap(captureRootRuntime, (runtime) => Effect.provideContext(effect, runtime));

/** Everything a workspace reads out of its context. Shell, Backend,
 *  PaneViews, LayoutKinds, OptionsRuntime, RootRuntime are References, not
 *  Services — they always resolve to a default and so carry no identity in
 *  the requirement channel; only the renderer is actually required. */
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
    layoutKinds?: LayoutKindLookup;
    options?: Options;
    runtime?: RootRuntimeContext;
  } = {},
): Context.Context<WorkspaceEnv> => {
  let env = Context.make(RenderCtx, ctx) as Context.Context<WorkspaceEnv>;
  if (options.shell) env = Context.add(env, Shell, options.shell);
  if (options.backend) env = Context.add(env, Backend, options.backend);
  if (options.paneContent) env = Context.add(env, PaneViews, options.paneContent);
  if (options.layoutKinds) env = Context.add(env, LayoutKinds, options.layoutKinds);
  if (options.options) env = Context.add(env, OptionsRuntime, options.options);
  if (options.runtime) env = Context.add(env, RootRuntime, options.runtime);
  return env;
};
