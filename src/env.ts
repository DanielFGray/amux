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

import { Context } from "effect";
import type { RenderContext } from "@opentui/core";
import { localPty, type SessionBackendFactory } from "./backend.ts";
import type { PaneView } from "./component-pane.tsx";

/** The renderer everything in a workspace draws into. No default: there is no
 *  sensible stand-in for a renderer, and a missing one should not be silently
 *  papered over with a fake that renders nowhere. */
export class RenderCtx extends Context.Tag("RenderCtx")<RenderCtx, RenderContext>() {}

/** Command a new agent runs. Comes from config; bash is what the config
 *  defaults to when the user has expressed no preference and $SHELL is unset. */
export class Shell extends Context.Reference<Shell>()("Shell", {
  defaultValue: (): string[] => ["bash"],
}) {}

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
export class Backend extends Context.Reference<Backend>()("Backend", {
  defaultValue: (): SessionBackendFactory => localPty,
}) {}

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
export class PaneContent extends Context.Reference<PaneContent>()("PaneContent", {
  defaultValue: (): PaneView | null => null,
}) {}

/** Everything a workspace reads out of its context. */
export type WorkspaceEnv = RenderCtx | Shell | Backend | PaneContent;

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
  options: { shell?: string[]; backend?: SessionBackendFactory; paneContent?: PaneView } = {},
): Context.Context<WorkspaceEnv> => {
  let env = Context.make(RenderCtx, ctx) as Context.Context<WorkspaceEnv>;
  if (options.shell) env = Context.add(env, Shell, options.shell);
  if (options.backend) env = Context.add(env, Backend, options.backend);
  if (options.paneContent) env = Context.add(env, PaneContent, options.paneContent);
  return env;
};
