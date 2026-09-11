/**
 * Per-file mutation queue so concurrent edit/write/apply_patch on one path
 * serialize. Cite: ../pi/.../file-mutation-queue.ts (Promise chain → Effect Semaphore).
 */
import { Effect, Semaphore } from "effect";

const locks = new Map<string, Semaphore.Semaphore>();

const lockFor = (absolutePath: string): Semaphore.Semaphore => {
  const existing = locks.get(absolutePath);
  if (existing) return existing;
  const created = Semaphore.makeUnsafe(1);
  locks.set(absolutePath, created);
  return created;
};

export const withFileMutation = <A, E, R>(
  absolutePath: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => lockFor(absolutePath).withPermits(1)(body);
