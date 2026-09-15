/** @effect-diagnostics *:skip-file -- test fixture: Effect.runPromise is the
 *  Bun test bridge, and ConfigProvider.fromUnknown takes the env map each
 *  suite builds. See the seam documented in harness.ts. */
/**
 * Daemon test runner: the services a daemon needs (SessionStore, FileSystem,
 * Path, ConfigProvider from a test env), a daemon start, and one control-plane
 * call.
 */
import { ConfigProvider, Effect, Layer, Path, Scope } from "effect";
import * as FileSystem from "effect/FileSystem";
import { BunFileSystem } from "@effect/platform-bun";
import { controlCall, type ControlClient } from "./control-client.ts";
import { startDaemon, type SessionDaemonOptions, type SessionDaemonService } from "./daemon.ts";
import { SessionStore } from "./session.ts";

/** Provide the daemon services from an env map, without scoping or running. */
export const provideDaemon = <A, E, R>(effect: Effect.Effect<A, E, R>, env: NodeJS.ProcessEnv) =>
  effect.pipe(
    Effect.provide(storeLayer),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );

/** Run a daemon effect in its own Scope and return its result. */
export const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore | FileSystem.FileSystem | Path.Path | Scope.Scope>,
  env: NodeJS.ProcessEnv,
): Promise<A> => Effect.runPromise(provideDaemon(Effect.scoped(effect), env));

/** Start a daemon under the test env. The caller stops it. */
export const open = (
  id: string,
  env: NodeJS.ProcessEnv,
  options?: SessionDaemonOptions,
): Promise<SessionDaemonService> => run(startDaemon(id, options), env);

/** One control-plane request against a running daemon. */
export const ctl = <A, E>(
  id: string,
  env: NodeJS.ProcessEnv,
  use: (control: ControlClient) => Effect.Effect<A, E>,
): Promise<A> => run(controlCall(id, use), env);

const storeLayer = SessionStore.layer.pipe(
  Layer.provideMerge(Layer.merge(BunFileSystem.layer, Path.layer)),
);
