import { Schema as S } from "effect"

const Hello = S.Struct({
  _tag: S.Literal("hello"),
  client: S.String,
})

const Output = S.Struct({
  _tag: S.Literal("output"),
  agent: S.String,
  data: S.Uint8ArrayFromBase64,
})

const Input = S.Struct({
  _tag: S.Literal("input"),
  agent: S.String,
  data: S.Uint8ArrayFromBase64,
})

const Resize = S.Struct({
  _tag: S.Literal("resize"),
  agent: S.String,
  cols: S.Int,
  rows: S.Int,
})

/**
 * Ask the daemon to replay an agent's current screen to this client.
 *
 * Sent once when a client adopts an agent the daemon is already running. The
 * daemon answers with an `output` frame carrying the serialized screen (modes
 * and content) ahead of the agent's live bytes, so a reattaching client's
 * pane is not blank until the program next redraws. Only adopted agents need
 * it: a freshly spawned agent's bytes reach the client from the first one.
 */
const Sync = S.Struct({
  _tag: S.Literal("sync"),
  agent: S.String,
})

const Exit = S.Struct({
  _tag: S.Literal("exit"),
  agent: S.String,
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
