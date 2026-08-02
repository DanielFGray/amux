import { Schema as S } from "effect"

/**
 * The server-side paste buffer stack.
 *
 * tmux and herdr both keep their buffers on the SERVER, not in any client:
 * the stack is what makes copy/paste work over ssh, between panes, and from a
 * script, because the bytes live next to the PTYs they get pasted into. This
 * is that store — a plain ordered set of named byte buffers owned by the
 * daemon's attach host, next to the sessions the paste verb writes into.
 *
 * The verbs are tmux's: set-buffer, paste-buffer, list-buffers, delete-buffer,
 * show-buffer, choose-buffer. Everything here is the data half of those
 * (paste-buffer additionally needs the target session, which lives in
 * SessionSupervisor — see AttachHost.paste).
 *
 * Deliberately a plain class rather than an Effect service: it owns no scope,
 * no fiber, no stream, so there is nothing for Effect's lifecycle to do. It is
 * constructed inside the attach-host layer, so it still dies with the daemon's
 * PTY plane — buffers are server state, and (as in tmux) they are not
 * persisted across a restart.
 */

export class BufferError extends S.TaggedError<BufferError>()("BufferError", {
  operation: S.String,
  message: S.String,
}) {}

/** One buffer, as a client would list it: the name, the size, and the first
 *  line as a preview. */
export interface BufferEntry {
  readonly name: string
  readonly bytes: number
  readonly preview: string
}

/** tmux's buffer-limit default: the stack keeps only the most recent 50
 *  buffers, dropping the oldest as new copies arrive. */
const DEFAULT_LIMIT = 50

const PREVIEW_COLUMNS = 64

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

export class PasteBuffers {
  /** Buffer names, top of the stack first. */
  #order: string[] = []
  #byName = new Map<string, Uint8Array>()
  readonly #limit: number

  constructor(limit = DEFAULT_LIMIT) {
    this.#limit = Math.max(1, limit)
  }

  /** The name of the top of the stack — what a default paste-buffer, show
   *  or delete reads — or null when the stack is empty. */
  get top(): string | null {
    return this.#order[0] ?? null
  }

  /**
   * Set a buffer's contents, the way tmux set-buffer does.
   *
   * With no name, a NEW buffer is created at the top of the stack, named with
   * the lowest unused number — every copy is a new buffer, so the most recent
   * copy is always what a default paste reads. Setting an existing name
   * replaces that buffer's contents in place, without moving it.
   *
   * Returns the name the data landed in.
   */
  set(name: string | undefined, data: string | Uint8Array): string {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    if (name !== undefined && this.#byName.has(name)) {
      this.#byName.set(name, bytes)
      return name
    }
    const assigned = name ?? this.#lowestUnusedName()
    this.#byName.set(assigned, bytes)
    this.#order.unshift(assigned)
    this.#trim()
    return assigned
  }

  /** The buffers, top of the stack first. */
  list(): BufferEntry[] {
    return this.#order.map((name) => {
      const bytes = this.#byName.get(name)!
      return { name, bytes: bytes.length, preview: this.#preview(bytes) }
    })
  }

  /** Delete a buffer; an absent name deletes the top of the stack. */
  delete(name?: string): void {
    if (name === undefined) {
      const top = this.top
      if (top === null) {
        throw new BufferError({ operation: "delete", message: "no buffers to delete" })
      }
      this.#byName.delete(top)
      this.#order.shift()
      return
    }
    if (!this.#byName.has(name)) {
      throw new BufferError({ operation: "delete", message: `no buffer '${name}'` })
    }
    this.#byName.delete(name)
    this.#order.splice(this.#order.indexOf(name), 1)
  }

  /** A buffer's bytes; an absent name reads the top of the stack. */
  show(name?: string): Uint8Array {
    const target = name ?? this.top
    if (target === null) {
      throw new BufferError({ operation: "show", message: "no buffers to show" })
    }
    const bytes = this.#byName.get(target)
    if (!bytes) {
      throw new BufferError({ operation: "show", message: `no buffer '${target}'` })
    }
    return bytes
  }

  /** The first free numeric name, tmux's numbering: 0, 1, 2, ... */
  #lowestUnusedName(): string {
    let n = 0
    while (this.#byName.has(String(n))) n++
    return String(n)
  }

  /** The first line, trimmed of trailing whitespace, as the list preview. */
  #preview(bytes: Uint8Array): string {
    const line = (text(bytes).split("\n", 1)[0] ?? "").trimEnd()
    return line.length > PREVIEW_COLUMNS ? `${line.slice(0, PREVIEW_COLUMNS)}…` : line
  }

  /** buffer-limit: drop the oldest buffers when the stack overgrows. */
  #trim(): void {
    while (this.#order.length > this.#limit) {
      const dropped = this.#order.pop()!
      this.#byName.delete(dropped)
    }
  }
}
