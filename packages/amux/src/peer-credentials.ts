/**
 * Who is on the other end of a unix socket.
 *
 * The control socket is amux's real security boundary: anything that can
 * connect to it can call Run and execute commands as you, at which point no
 * credential file on disk matters. Until now that socket was protected only
 * incidentally, by living inside a 0700 session root — the right mode, but a
 * property of a directory someone could later create elsewhere rather than a
 * check the daemon makes. This makes it a check.
 *
 * `SO_PEERCRED` is answered by the kernel from the peer's state at connect
 * time. It cannot be forged by the connecting process, which is what makes it
 * worth more than anything the peer could tell us about itself.
 *
 * Scope, stated plainly: this identifies the *user*, not the program. A pane
 * amux itself spawned runs as the same uid as the daemon, so this check does
 * not constrain it. Keeping a pane's self-report from authorizing privileged
 * action is a separate boundary, enforced elsewhere.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { Socket as NetSocket } from "node:net";

export interface PeerCredentials {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

/** `SOL_SOCKET`/`SO_PEERCRED` and the `struct ucred` layout, from the Linux ABI. */
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const UCRED_BYTES = 12;

/**
 * libc under whichever name this distribution ships it as. glibc and musl
 * disagree, and the musl name carries the architecture, so the answer is found
 * by trying rather than by naming one.
 */
const LIBC_CANDIDATES = [
  "libc.so.6",
  `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`,
  "libc.so",
];

const getsockopt = (() => {
  for (const name of LIBC_CANDIDATES) {
    try {
      return dlopen(name, {
        getsockopt: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
      }).symbols.getsockopt;
    } catch {
      continue;
    }
  }
  return null;
})();

/**
 * Read the connected peer's credentials, or `null` when they cannot be read.
 *
 * `null` means "unknown", never "fine": every caller refuses the connection on
 * it. A platform without `SO_PEERCRED` therefore fails closed and loudly rather
 * than quietly accepting everyone, which is the only safe direction for a check
 * whose whole job is to refuse.
 */
export function peerCredentials(fd: number): PeerCredentials | null {
  if (getsockopt === null || fd < 0) return null;
  const cred = new Int32Array(3);
  const length = new Int32Array([UCRED_BYTES]);
  const rc = getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(cred), ptr(length));
  if (rc !== 0 || length[0] !== UCRED_BYTES) return null;
  return { pid: cred[0]!, uid: cred[1]!, gid: cred[2]! };
}

/**
 * Who counts as us: the peer is admitted only when it runs as the same user.
 *
 * Separate from reading the descriptor so the rule can be stated against a
 * uid that this process does not have — the refusal is the whole point of the
 * check, and it is the branch a test cannot otherwise reach without a second
 * account to connect from.
 */
export function admits(peer: PeerCredentials | null, selfUid: number | undefined): boolean {
  return peer !== null && selfUid !== undefined && peer.uid === selfUid;
}

/**
 * True when the peer runs as the same user as this process.
 *
 * The socket file's own mode already stops another user from opening it, so a
 * refusal here means the mode was wrong — a socket created outside the 0700
 * session root, or one whose directory was replaced. That is exactly the case
 * the directory mode alone cannot rule out.
 */
export function isSameUserPeer(fd: number): boolean {
  return admits(peerCredentials(fd), process.getuid?.());
}

/**
 * The fd behind either socket implementation, or -1 when it has none.
 *
 * `Bun.Socket` exposes `fd`; `node:net` keeps it on the libuv handle, which is
 * private and so absent from its public type. Neither is declared, so both are
 * read through one narrow shape rather than at each call site — a closed or
 * unconnected socket simply has no descriptor, and -1 is refused upstream like
 * any other unreadable peer.
 */
export function socketFd(socket: NetSocket | Bun.Socket<unknown> | null | undefined): number {
  const bearing = socket as { fd?: unknown; _handle?: { fd?: unknown } } | null | undefined;
  const fd = typeof bearing?.fd === "number" ? bearing.fd : bearing?._handle?.fd;
  return typeof fd === "number" ? fd : -1;
}
