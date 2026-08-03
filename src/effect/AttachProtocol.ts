import { Schema as S } from "effect"

/**
 * The framed wire protocol between a client and the attach daemon.
 *
 * Vocabulary (survives from the rename off `agent`):
 * - session: a daemon-owned backend instance — a supervised PTY today, an LLM
 *   agent session later. Every frame field named `session` identifies one.
 * - pane: a view of a session in a UI layout.
 * - agent: an LLM coding agent (the future backend kind), never the supervised
 *   PTY. The old name for the PTY-scoped meaning collided with this.
 */
const Hello = S.Struct({
  _tag: S.Literal("hello"),
  client: S.String,
})

const Output = S.Struct({
  _tag: S.Literal("output"),
  session: S.String,
  data: S.Uint8ArrayFromBase64,
})

const Input = S.Struct({
  _tag: S.Literal("input"),
  session: S.String,
  data: S.Uint8ArrayFromBase64,
})

const Resize = S.Struct({
  _tag: S.Literal("resize"),
  session: S.String,
  cols: S.Int,
  rows: S.Int,
})

/**
 * Ask the daemon to replay a session's current screen to this client.
 *
 * Sent once when a client adopts a session the daemon is already running. The
 * daemon answers with an `output` frame carrying the serialized screen (modes
 * and content) ahead of the session's live bytes, so a reattaching client's
 * pane is not blank until the program next redraws. Only adopted sessions need
 * it: an attached client sees a newly created session's bytes from the first one.
 */
const Sync = S.Struct({
  _tag: S.Literal("sync"),
  session: S.String,
})

/**
 * The daemon's answer to "what is in the foreground of this session's tty".
 *
 * The daemon owns the PTY, so only it can ask the tty which process group is
 * in the foreground (tcgetpgrp) and what its session id is (tcgetsid); a
 * client reading the same tty gets -1. Sent whenever either value changes —
 * and once when the session starts, so attached clients observing a new or
 * adopted session learn the current state without asking. The client keeps
 * reading /proc for the actual cmdline: pids are a global namespace, the
 * foreground pgid is not.
 */
const Foreground = S.Struct({
  _tag: S.Literal("foreground"),
  session: S.String,
  /** Foreground process group of the controlling tty, or -1. Equal to the
   *  session id while a shell sits at a prompt. */
  pgid: S.Int,
  /** Session id = the session leader's pid, or -1 when it is not knowable. */
  sid: S.Int,
})

/**
 * An authoritative workspace generation. Model state is a separate tagged
 * concern on the shared transport; terminal byte frames retain their own
 * session ordering and routing.
 */
const Workspace = S.Struct({
  _tag: S.Literal("workspace"),
  revision: S.NonNegativeInt,
  state: S.String,
})

const Exit = S.Struct({
  _tag: S.Literal("exit"),
  session: S.String,
  code: S.NullOr(S.Int),
})

const ErrorFrame = S.Struct({
  _tag: S.Literal("error"),
  message: S.String,
})

const Ping = S.Struct({
  _tag: S.Literal("ping"),
  nonce: S.String,
})

const Pong = S.Struct({
  _tag: S.Literal("pong"),
  nonce: S.String,
})

export const AttachFrame = S.Union(Hello, Output, Input, Resize, Sync, Exit, Foreground, Workspace, ErrorFrame, Ping, Pong)
export type AttachFrame = S.Schema.Type<typeof AttachFrame>

export class AttachProtocolError extends S.TaggedError<AttachProtocolError>()("AttachProtocolError", {
  message: S.String,
}) {}

/** Encode one frame. Newline is the framing boundary, not part of the payload. */
export function encodeAttachFrame(frame: AttachFrame): string {
  return `${JSON.stringify(S.encodeSync(AttachFrame)(frame))}\n`
}

/**
 * Decode as many complete newline-delimited frames as are available.
 * Incomplete trailing data is returned for the next socket read.
 */
export function decodeAttachFrames(input: string): { frames: AttachFrame[]; rest: string } {
  const lines = input.split("\n")
  const rest = lines.pop() ?? ""
  const frames: AttachFrame[] = []

  for (const line of lines) {
    if (!line) continue
    try {
      frames.push(S.decodeUnknownSync(AttachFrame)(JSON.parse(line)))
    } catch (error) {
      throw new AttachProtocolError({
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { frames, rest }
}
