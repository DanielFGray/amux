/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
import { test, expect, afterEach } from "bun:test";
import * as Net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admits, isSameUserPeer, peerCredentials, socketFd } from "./peer-credentials.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A connected unix socket pair, handing back the server side's descriptor. */
function connectedPair(): Promise<{ fd: number; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "amux-peercred-"));
  dirs.push(dir);
  const path = join(dir, "s.sock");
  return new Promise((resolve, reject) => {
    const server = Net.createServer((conn) => {
      resolve({
        fd: socketFd(conn),
        close: () => {
          conn.destroy();
          server.close();
        },
      });
    });
    server.once("error", reject);
    server.listen(path, () => {
      Net.createConnection(path).once("error", reject);
    });
  });
}

test("reads the connecting process's own credentials", async () => {
  const { fd, close } = await connectedPair();
  try {
    const peer = peerCredentials(fd);
    expect(peer).not.toBeNull();
    // Both ends are this test process, so the kernel's answer is knowable
    // exactly — which is what proves the struct layout is read correctly and
    // not merely that some non-null value came back.
    expect(peer!.pid).toBe(process.pid);
    expect(peer!.uid).toBe(process.getuid!());
    expect(peer!.gid).toBe(process.getgid!());
  } finally {
    close();
  }
});

test("accepts a peer running as this user", async () => {
  const { fd, close } = await connectedPair();
  try {
    expect(isSameUserPeer(fd)).toBe(true);
  } finally {
    close();
  }
});

test("refuses a descriptor whose credentials cannot be read", () => {
  // A uid that cannot be established is refused exactly like a foreign one:
  // the check exists to turn peers away, so its failure mode must be closed.
  // Nothing here is a socket, so the kernel has no credentials to report.
  for (const fd of [-1, 2_000_000_000]) {
    expect(peerCredentials(fd)).toBeNull();
    expect(isSameUserPeer(fd)).toBe(false);
  }
});

test("refuses a peer belonging to another user", () => {
  // An unprivileged test cannot connect from a second account, so the rule is
  // driven directly: a real credential set is admitted only against its own
  // uid, and refused against any other.
  const peer = { pid: 4321, uid: 1000, gid: 1000 };
  expect(admits(peer, 1000)).toBe(true);
  expect(admits(peer, 0)).toBe(false);
  expect(admits(peer, 1001)).toBe(false);
  // Unreadable credentials, and a process whose own uid is unknown, both fail
  // closed rather than falling through to admission.
  expect(admits(null, 1000)).toBe(false);
  expect(admits(peer, undefined)).toBe(false);
});

test("finds the descriptor behind a real node socket, and none where there is none", async () => {
  // node:net keeps the descriptor on its private libuv handle, so this is worth
  // asserting against a live socket rather than a literal: a stand-in would
  // only prove the reader agrees with a shape this file made up.
  const { fd, close } = await connectedPair();
  try {
    expect(fd).toBeGreaterThanOrEqual(0);
  } finally {
    close();
  }
  // A socket with no descriptor yields -1, which every caller refuses.
  expect(socketFd(new Net.Socket())).toBe(-1);
  expect(socketFd(null)).toBe(-1);
  expect(socketFd(undefined)).toBe(-1);
});
