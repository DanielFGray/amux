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
 * it: a freshly spawned session's bytes reach the client from the first one.
 */
const Sync = S.Struct({
  _tag: S.Literal("sync"),
  session: S.String,
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

export const AttachFrame = S.Union(Hello, Output, Input, Resize, Sync, Exit, ErrorFrame, Ping, Pong)
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
