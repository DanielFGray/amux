/**
 * Process-state socket behaviour on AttachHost without a full daemon.
 *
 * @effect-diagnostics *:skip-file -- Unix socket boundary this suite drives unmocked.
 */
import { expect } from "bun:test";
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { join } from "node:path";
import { AttachHost, layerAttachHost } from "./AttachHost.ts";
import { testEffect } from "../test-effect.ts";
import { registerCleanup, tempDir } from "../test-tmp.ts";
import { waitFor } from "../test-wait.ts";

registerCleanup();

testEffect("the process state socket accepts ping and process state reports", () => {
  const root = tempDir("attach-host-process-state");
  const attachPath = join(root, "attach.sock");
  const processStatePath = join(root, "process-state.sock");

  return Effect.gen(function* () {
    yield* AttachHost;
    yield* Effect.promise(() =>
      waitFor(async () => {
        try {
          const probe = await Bun.connect({
            unix: processStatePath,
            socket: { data: () => {} },
          });
          probe.end();
          return true;
        } catch {
          return false;
        }
      }, "process-state socket listening"),
    );

    const lines: string[] = [];
    const socket = yield* Effect.promise(() =>
      Bun.connect({
        unix: processStatePath,
        socket: {
          data: (_socket, data) => {
            lines.push(data.toString());
          },
        },
      }),
    );
    socket.write(JSON.stringify({ id: "one", method: "ping" }) + "\n");
    socket.write(
      JSON.stringify({
        id: "two",
        method: "process.state",
        params: { session: "pane-a", state: "blocked" },
      }) + "\n",
    );
    yield* Effect.promise(() =>
      waitFor(
        () => lines.join("\n").includes('"id":"one"') && lines.join("\n").includes('"id":"two"'),
        "both pipelined replies",
      ),
    );
    socket.end();
    expect(lines.join("\n")).toContain('"id":"one"');
    expect(lines.join("\n")).toContain('"id":"two"');
    expect(lines.join("\n")).toContain('"ok":true');
  }).pipe(
    Effect.scoped,
    Effect.provide(layerAttachHost({ path: attachPath, processStatePath })),
    Effect.provide(BunFileSystem.layer),
  );
});
