import { Clock, Effect, Layer, Schema } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { controlCall, type ControlClient } from "./control-client.ts";
import { isSessionId, processAlive, SessionStore } from "./session.ts";
import { parseWorkspaceJson } from "./workspace.ts";

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Every known session id paired with whether its daemon is currently alive. */
export const sessionAliveness = Effect.fnUntraced(function* () {
  const ids = yield* Effect.flatMap(SessionStore, (store) => store.list);
  return yield* Effect.forEach(ids, (id) =>
    Effect.flatMap(SessionStore, (store) => store.readLease(id)).pipe(
      Effect.map((lease) => ({ id, lease, alive: lease !== null && processAlive(lease.pid) })),
      Effect.orElseSucceed(() => ({ id, lease: null, alive: false })),
    ),
  );
});

/** Ids of every session whose daemon is currently alive. */
export function runningSessionIds(): Promise<string[]> {
  return Effect.runPromise(
    sessionAliveness().pipe(
      Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
    ),
  ).then((rows) => rows.filter((row) => row.alive).map((row) => row.id));
}

/** `amux list`: every known session id, and whether its daemon is alive. */
function listSessions(): Promise<number> {
  return Effect.runPromise(
    sessionAliveness().pipe(
      Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
    ),
  ).then((rows) => {
    if (rows.length === 0) {
      process.stdout.write("no sessions\n");
      return 0;
    }
    const now = Effect.runSync(Clock.currentTimeMillis);
    const table = rows.map(({ id, lease, alive }) => ({
      session: id,
      status: alive ? "running" : "stopped",
      pid: alive && lease ? String(lease.pid) : "-",
      uptime: alive && lease ? formatUptime(now - lease.startedAt) : "-",
      attached: alive && lease ? String(lease.attachments?.length ?? 0) : "-",
    }));
    const columns = ["session", "status", "pid", "uptime", "attached"] as const;
    const widths = columns.map((col) =>
      Math.max(col.length, ...table.map((row) => row[col].length)),
    );
    const printRow = (values: readonly string[]) =>
      process.stdout.write(values.map((v, i) => v.padEnd(widths[i]!)).join("  ") + "\n");
    printRow(columns);
    for (const row of table) printRow(columns.map((col) => row[col]));
    return 0;
  });
}

/** `amux status <id>` / `amux stop <id>` / `amux list`: one-shot lifecycle commands. */
export function runSessionCli(argv: string[]): Promise<number> {
  const [verb, id = "default"] = argv;
  if (!verb || !["status", "stop", "list"].includes(verb)) {
    process.stderr.write("usage: amux <status|stop|list> [session-id]\n");
    return Promise.resolve(2);
  }
  if (verb === "list") return listSessions();
  if (!isSessionId(id)) {
    process.stderr.write(`invalid session id ${JSON.stringify(id)}\n`);
    return Promise.resolve(2);
  }

  const call = <A, E>(use: (control: ControlClient) => Effect.Effect<A, E>) =>
    controlCall(id, use).pipe(
      Effect.provide(SessionStore.layer.pipe(Layer.provideMerge(BunFileSystem.layer))),
    );

  return Effect.runPromise(
    Effect.gen(function* () {
      if (verb === "stop") {
        yield* call((control) => control.Stop());
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown, { space: 2 }),
        )({ stopped: true });
        process.stdout.write(encoded + "\n");
        return 0;
      }
      const { workspace, ...rest } = yield* call((control) => control.Status());
      const parsed = yield* parseWorkspaceJson(workspace);
      const report = { ...rest, workspace: parsed };
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown, { space: 2 }),
      )(report);
      process.stdout.write(encoded + "\n");
      return report.degraded === undefined ? 0 : 1;
    }),
  ).catch((error) => {
    process.stderr.write(`session '${id}' is unavailable: ${String(error)}\n`);
    return 1;
  });
}

if (import.meta.main) process.exit(await runSessionCli(process.argv.slice(2)));
