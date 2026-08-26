import { Effect } from "effect";
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
  const ids = yield* SessionStore.list;
  return yield* Effect.forEach(ids, (id) =>
    SessionStore.readLease(id).pipe(
      Effect.map((lease) => ({ id, lease, alive: lease !== null && processAlive(lease.pid) })),
      Effect.orElseSucceed(() => ({ id, lease: null, alive: false })),
    ),
  );
});

/** Ids of every session whose daemon is currently alive. */
export async function runningSessionIds(): Promise<string[]> {
  const rows = await Effect.runPromise(
    sessionAliveness().pipe(Effect.provide(SessionStore.Default), Effect.provide(BunFileSystem.layer)),
  );
  return rows.filter((row) => row.alive).map((row) => row.id);
}

/** `amux list`: every known session id, and whether its daemon is alive. */
async function listSessions(): Promise<number> {
  const rows = await Effect.runPromise(
    sessionAliveness().pipe(Effect.provide(SessionStore.Default), Effect.provide(BunFileSystem.layer)),
  );
  if (rows.length === 0) {
    console.log("no sessions");
    return 0;
  }
  const now = Date.now();
  const table = rows.map(({ id, lease, alive }) => ({
    session: id,
    status: alive ? "running" : "stopped",
    pid: alive && lease ? String(lease.pid) : "-",
    uptime: alive && lease ? formatUptime(now - lease.startedAt) : "-",
    attached: alive && lease ? String(lease.attachments?.length ?? 0) : "-",
  }));
  const columns = ["session", "status", "pid", "uptime", "attached"] as const;
  const widths = columns.map((col) => Math.max(col.length, ...table.map((row) => row[col].length)));
  const printRow = (values: readonly string[]) =>
    console.log(values.map((v, i) => v.padEnd(widths[i]!)).join("  "));
  printRow(columns);
  for (const row of table) printRow(columns.map((col) => row[col]));
  return 0;
}

/** `amux status <id>` / `amux stop <id>` / `amux list`: one-shot lifecycle commands. */
export async function runSessionCli(argv: string[]): Promise<number> {
  const [verb, id = "default"] = argv;
  if (!verb || !["status", "stop", "list"].includes(verb)) {
    console.error("usage: amux <status|stop|list> [session-id]");
    return 2;
  }
  if (verb === "list") return listSessions();
  if (!isSessionId(id)) {
    console.error(`invalid session id ${JSON.stringify(id)}`);
    return 2;
  }

  const call = <A, E>(use: (control: ControlClient) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      controlCall(id, use).pipe(
        Effect.provide(SessionStore.Default),
        Effect.provide(BunFileSystem.layer),
      ),
    );

  try {
    if (verb === "stop") {
      await call((control) => control.Stop());
      process.stdout.write(JSON.stringify({ stopped: true }, null, 2) + "\n");
      return 0;
    }
    const { workspace, ...rest } = await call((control) => control.Status());
    const parsed = Effect.runSync(parseWorkspaceJson(workspace));
    const report = { ...rest, workspace: parsed };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.degraded === undefined ? 0 : 1;
  } catch (error) {
    console.error(`session '${id}' is unavailable: ${String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runSessionCli(process.argv.slice(2)));
