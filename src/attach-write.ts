export interface SocketWriter {
  readonly closed: boolean
  send(value: Uint8Array): boolean
  drain(): void
  close(): void
}

const MAX_PENDING_BYTES = 4 * 1024 * 1024

/** Serialize unbuffered Bun socket writes without losing partial frames. */
export const createSocketWriter = (
  socket: { write(data: Uint8Array, offset: number, length: number): number },
  onClose: () => void,
  maxPendingBytes = MAX_PENDING_BYTES,
): SocketWriter => {
  const pending: Uint8Array[] = []
  let pendingBytes = 0
  let offset = 0
  let closed = false
  let pumping = false
  let waitingDrain = false

  const fail = () => {
    if (closed) return
    closed = true
    pending.length = 0
    pendingBytes = 0
    onClose()
  }

  const pump = () => {
    if (closed || pumping || waitingDrain) return
    pumping = true
    try {
      while (!closed && pending.length > 0) {
        const frame = pending[0]!
        const remaining = frame.length - offset
        let written: number
        try {
          written = socket.write(frame, offset, remaining)
        } catch {
          fail()
          return
        }
        if (written < 0 || written > remaining) {
          fail()
          return
        }
        if (written === 0) {
          waitingDrain = true
          return
        }
        offset += written
        pendingBytes -= written
        if (offset === frame.length) {
          pending.shift()
          offset = 0
        } else {
          waitingDrain = true
          return
        }
      }
    } finally {
      pumping = false
    }
  }

  return {
    get closed() { return closed },
    send(bytes) {
      if (closed) return false
      if (pendingBytes + bytes.length > maxPendingBytes) {
        fail()
        return false
      }
      pending.push(bytes)
      pendingBytes += bytes.length
      pump()
      return !closed
    },
    drain() {
      if (closed) return
      waitingDrain = false
      pump()
    },
    close() {
      closed = true
      pending.length = 0
      pendingBytes = 0
    },
  }
}
