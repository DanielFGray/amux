/**
 * Caller context for a workspace command — leaf module so attach frames and
 * control Batch share one schema without pulling workspace.ts or commands.ts.
 */
import { Schema as S } from "effect";
import { MAX_TERMINAL_CELLS, MAX_TERMINAL_DIMENSION } from "./limits.ts";
import { NonEmptyString } from "./schema-primitives.ts";

const TerminalDimension = S.Int.pipe(
  S.check(S.isGreaterThan(0)),
  S.check(S.isLessThanOrEqualTo(MAX_TERMINAL_DIMENSION)),
);

const TerminalSize = S.Struct({
  cols: TerminalDimension,
  rows: TerminalDimension,
}).pipe(
  S.check(
    S.makeFilter(({ cols, rows }) => cols * rows <= MAX_TERMINAL_CELLS, {
      message: "terminal size is too large",
    }),
  ),
);

export const WorkspaceCommandContextSchema = S.Struct({
  size: TerminalSize,
  shell: S.Array(NonEmptyString).pipe(S.check(S.isMinLength(1))),
  cwd: NonEmptyString,
  /** Native agents execute workspace commands in the window containing them. */
  agent: S.optional(NonEmptyString),
  /** The pane the caller runs in, when the call came from inside one. */
  pane: S.optional(NonEmptyString),
  /**
   * Who issued this command: a key press, the attached client, or the CLI.
   * Forwarded onto client `command.request` frames so {@link Commands.run}
   * builds the same invocation record on every surface.
   */
  source: S.optional(S.Literals(["key", "socket", "cli"])),
  /** The daemon-owned session that caused a command from its process. This is
   * only attribution for durable feedback, never a workspace target. Distinct
   * from {@link agent} (`AMUX_AGENT_ID`): this is `AMUX_SESSION`, which is the
   * agent id in a component worker and the mux session name in the TUI. */
  originSession: S.optional(NonEmptyString),
  /** True when a background caller asked for no focus to move. The mutation
   *  applies its structure but leaves the workspace's focus and activation
   *  state exactly as it found it. */
  noFocus: S.optional(S.Boolean),
  /** Client-observed attention state, used only by session.next-blocked. */
  blockedAgents: S.optional(S.Array(NonEmptyString)),
  /** A pre-processed payload for a workspace command that wants one, alongside
   *  `PanelContext.run`. `pane.send-keys` used to be its only caller; it now
   *  writes to its session directly (or routes to a client) instead. */
  input: S.optional(S.String),
  /** Root directory for space worktrees. Daemon authority: derived from the
   *  session env, never the client. Required only when a command creates a
   *  worktree space (space.new with a branch). */
  worktreesRoot: S.optional(S.String),
});

/**
 * Caller context for a workspace command. Derived from
 * {@link WorkspaceCommandContextSchema} so RPC payloads and in-process callers
 * share one shape (no shell-array copy at the host Reduce boundary).
 */
export type WorkspaceCommandContext = typeof WorkspaceCommandContextSchema.Type;
