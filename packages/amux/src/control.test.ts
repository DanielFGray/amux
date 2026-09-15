/**
 * The control plane end to end: a real `@effect/rpc` client against the real
 * daemon, over the session's real Unix socket.
 *
 * Slow-lane process/socket lifecycle checks live in `e2e/control-process.test.ts`.
 *
 * @effect-diagnostics *:skip-file -- a real OS boundary (sockets, subprocess) this suite deliberately
 * drives unmocked. See the seam documented in packages/amux/src/harness.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Stream, Schema as S } from "effect";
import { startDaemon, type SessionDaemonService } from "./daemon.ts";
import { connectControl } from "./control-client.ts";
import { command } from "./commands.ts";
import { OwnerJsonText } from "./layout.ts";
import { registerCleanup, tempDir } from "./test-tmp.ts";
import { waitFor } from "./test-wait.ts";
import { parseWorkspaceJson } from "./workspace.ts";
import { testEffect } from "./test-effect.ts";

const descriptorText = (value: typeof OwnerJsonText.Encoded) => S.decodeSync(OwnerJsonText)(value);
import { ctl, run } from "./test-daemon.ts";

registerCleanup();

const daemons: SessionDaemonService[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop).catch(() => {});
});

async function started(id: string, opts?: { plugins?: boolean }) {
  const home = tempDir("control");
  const configHome = join(home, "config");
  const withPlugins = opts?.plugins === true;
  const harness = new URL("../../plugin-agent-harness", import.meta.url).pathname;
  const continuity = new URL("../../plugin-agent-continuity", import.meta.url).pathname;
  const editor = new URL("../../editor", import.meta.url).pathname;
  const plugins = withPlugins
    ? [
        { path: harness, enabled: true },
        { path: continuity, enabled: true },
        { path: editor, enabled: true },
      ]
    : [];
  const pluginConfig = withPlugins
    ? {
        options: {},
        keys: { prefix: "ctrl+a", leader: "space", bindings: {} },
        plugins,
        permissions: [],
        layoutRules: [],
      }
    : undefined;
  if (withPlugins) {
    await mkdir(join(configHome, "amux"), { recursive: true });
    await writeFile(join(configHome, "amux", "config.json"), JSON.stringify({ plugins }));
  }
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: configHome,
  } as NodeJS.ProcessEnv;
  const daemon = await run(withPlugins ? startDaemon(id, { pluginConfig }) : startDaemon(id), env);
  daemons.push(daemon);
  return { daemon, env };
}

const context = { size: { cols: 80, rows: 24 }, shell: ["sh"], cwd: "/tmp" };

function workspacePaneId(workspace: {
  spaces: Array<{ windows: Array<{ layout: { root: unknown } }> }>;
}): string {
  const layout = workspace.spaces[0]!.windows[0]!.layout as {
    root:
      | { type: "pane"; id: string }
      | { type: "split"; children: Array<{ type: "pane"; id: string }> };
  };
  if (layout.root.type === "pane") return layout.root.id;
  return layout.root.children[0]!.id;
}

test("workspace JSON responses are schema-validated before projection", () => {
  expect(Effect.runSyncExit(parseWorkspaceJson("not json"))._tag).toBe("Failure");
  expect(Effect.runSyncExit(parseWorkspaceJson(JSON.stringify({ revision: 0 })))._tag).toBe(
    "Failure",
  );
});

test("ping and status answer over the session's unix socket", async () => {
  const { daemon, env } = await started("control-status");

  expect(await ctl(daemon.id, env, (c) => c.Ping())).toEqual({
    attached: false,
  });

  const status = await ctl(daemon.id, env, (c) => c.Status());
  expect(status.session.id).toBe("control-status");
  expect(status.degraded).toBeUndefined();
  expect(JSON.parse(status.workspace).spaces).toHaveLength(1);
  expect(status.agents).toHaveLength(1);
});

test("one connection serves many requests for its whole scope", async () => {
  const { daemon, env } = await started("control-reuse");
  const seen = await run(
    Effect.gen(function* () {
      const control = yield* connectControl(daemon.id);
      yield* control.SetBuffer({ name: "a", data: "one" });
      yield* control.SetBuffer({ name: "b", data: "two" });
      return yield* control.ListBuffers();
    }),
    env,
  );
  expect(seen.map((entry) => entry.name).sort()).toEqual(["a", "b"]);
});

/* The handshake is what makes the stream usable: a subscriber that acts only
 * after `events.ready` knows it cannot have missed an event its own action
 * caused. Workspace changes are not on this stream — they reach clients as
 * whole snapshots over the attach channel. */
test("the events stream opens with a readiness handshake", async () => {
  const { daemon, env } = await started("control-events");
  const first = await run(
    Effect.gen(function* () {
      const control = yield* connectControl(daemon.id);
      return yield* Stream.runHead(control.Events());
    }),
    env,
  );
  await Effect.runPromise(daemon.stop).catch(() => {});
  daemons.splice(daemons.indexOf(daemon), 1);
  expect(Option.map(first, (item) => item)).toEqual(
    Option.some({ sequence: 0, event: { _tag: "events.ready" } }),
  );
});

test("a refused command arrives as the daemon's typed failure, not a crash", async () => {
  const { daemon, env } = await started("control-typed-failure");
  const workspace = Effect.runSync(daemon.getWorkspace);

  const error = await ctl(daemon.id, env, (c) =>
    Effect.flip(
      c.Batch({
        values: [command("space.rename", { name: "loser" })],
        expectedRevision: workspace.revision + 99,
        context,
      }),
    ),
  );
  expect(error._tag).toBe("ControlError");
  expect(error.message).toContain("stale workspace revision");

  // The connection that carried the failure is still a working connection.
  expect((await ctl(daemon.id, env, (c) => c.Status())).degraded).toBeUndefined();
});

test("a command batch runs in order and carries its workspace revision forward", async () => {
  const { daemon, env } = await started("control-batch");
  const before = Effect.runSync(daemon.getWorkspace);

  const { outputs } = await ctl(daemon.id, env, (c) =>
    c.Batch({
      values: [
        command("space.rename", { name: "first" }),
        command("space.rename", { name: "named-remotely" }),
      ],
      expectedRevision: before.revision,
      context,
    }),
  );
  expect(outputs).toHaveLength(2);
  expect(JSON.parse(outputs[0]!.workspace!).revision).toBe(before.revision + 1);
  expect(JSON.parse(outputs[1]!.workspace!).revision).toBe(before.revision + 2);
  expect(Effect.runSync(daemon.getWorkspace).spaces[0]!.name).toBe("named-remotely");
});

test("an empty command batch is rejected", async () => {
  const { daemon, env } = await started("control-empty-batch");
  const error = await ctl(daemon.id, env, (c) => Effect.flip(c.Batch({ values: [] })));
  expect(error.message).toContain("must not be empty");
});

testEffect(
  "session.kill <agent-id> from inside a pane kills that agent, not the daemon connection",
  () =>
    Effect.gen(function* () {
      const { daemon } = yield* Effect.promise(() => started("kill-by-id"));
      const before = Effect.runSync(daemon.getWorkspace);
      const pane = workspacePaneId(before);
      const caller = before.spaces[0]!.windows[0]!.sessions[0]!.id;

      const split = yield* daemon.runWorkspaceCommand(
        command("pane.split", { axis: "row" }),
        before.revision,
        context,
      );
      const target = (split.result as { session: string }).session;

      yield* daemon.runWorkspaceCommand(
        command("session.kill", { target }),
        split.snapshot.revision,
        { ...context, pane, agent: caller },
      );
      const after = Effect.runSync(daemon.getWorkspace);
      expect(JSON.stringify(after)).not.toContain(target);
    }),
);

testEffect("a native agent can capture a live session through the command surface", () =>
  Effect.gen(function* () {
    const { daemon, env } = yield* Effect.promise(() => started("agent-tools"));
    const id = "capture-agent";
    yield* daemon.spawnSession({
      kind: "pty",
      id,
      cmd: ["sh", "-c", "printf 'capture-me\\n'; sleep 30"],
      cols: 80,
      rows: 24,
    });
    const capture = () =>
      ctl(daemon.id, env, (c) => c.Batch({ values: [command("pane.capture", { session: id })] }));
    let outputs = (yield* Effect.promise(() => capture())).outputs;
    yield* Effect.promise(() =>
      waitFor(async () => {
        outputs = (await capture()).outputs;
        return String(outputs[0]!.result).includes("capture-me");
      }, "the pane to print before it is captured"),
    );
    expect(outputs[0]!.result).toContain("capture-me");
    yield* daemon.killSession(id);
  }),
);

test("the read surface resolves the calling pane from inside one", async () => {
  const { daemon, env } = await started("cli-read-surface");
  const workspace = Effect.runSync(daemon.getWorkspace);
  const space = workspace.spaces[0]!;
  const pane = workspacePaneId(workspace);
  const session = space.windows[0]!.sessions[0]!.id;
  const caller = { ...context, pane, agent: session };

  const current = await ctl(daemon.id, env, (c) =>
    c.Batch({ values: [command("pane.current")], context: caller }),
  );
  expect(current.outputs[0]!.result).toMatchObject({
    id: pane,
    space: space.id,
    window: 1,
    session,
  });

  const layout = await ctl(daemon.id, env, (c) =>
    c.Batch({ values: [command("pane.layout")], context: caller }),
  );
  expect(layout.outputs[0]!.result).toMatchObject({
    pane,
    size: { cols: 80, rows: 24 },
  });

  const panes = await ctl(daemon.id, env, (c) =>
    c.Batch({ values: [command("pane.list")], context: caller }),
  );
  expect(panes.outputs[0]!.result).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: pane, space: space.id })]),
  );

  // A read never moves focus or changes the model.
  expect(Effect.runSync(daemon.getWorkspace).revision).toBe(workspace.revision);
});

test("pane.capture without a named pane acts on the calling pane, not focus", async () => {
  const { daemon, env } = await started("capture-caller-not-focus");
  const workspace = Effect.runSync(daemon.getWorkspace);
  const paneA = workspacePaneId(workspace);
  const sessionA = workspace.spaces[0]!.windows[0]!.sessions[0]!.id;

  const split = await ctl(daemon.id, env, (c) =>
    c.Batch({
      values: [command("pane.split", { axis: "row" })],
      expectedRevision: workspace.revision,
      context,
    }),
  );
  const created = split.outputs[0]!.result as { session: string; pane: string };
  const afterSplit = Effect.runSync(daemon.getWorkspace);
  expect(afterSplit.spaces[0]!.windows[0]!.state.focus).toBe(created.pane);

  await ctl(daemon.id, env, (c) =>
    c.Batch({
      values: [command("pane.send-keys", { pane: paneA, keys: "printf 'caller-pane\\n'" })],
    }),
  );
  await ctl(daemon.id, env, (c) =>
    c.Batch({
      values: [command("pane.send-keys", { pane: created.pane, keys: "printf 'focus-pane\\n'" })],
    }),
  );

  let callerText = "";
  await waitFor(async () => {
    const { outputs } = await ctl(daemon.id, env, (c) =>
      c.Batch({
        values: [command("pane.capture")],
        context: { ...context, pane: paneA, agent: sessionA },
      }),
    );
    callerText = String(outputs[0]!.result);
    return callerText.includes("caller-pane");
  }, "caller pane to show its mark");

  expect(callerText).toContain("caller-pane");
  expect(callerText).not.toContain("focus-pane");
});

test("send-keys --dispatch requires an attached client even for a session-backed pane", async () => {
  const { daemon, env } = await started("cli-send-keys-dispatch");
  const workspace = Effect.runSync(daemon.getWorkspace);
  const pane = workspacePaneId(workspace);

  const error = await ctl(daemon.id, env, (c) =>
    Effect.flip(
      c.Batch({ values: [command("pane.send-keys", { pane, keys: "x", dispatch: true })] }),
    ),
  );
  expect(error._tag).toBe("ControlError");
  expect(error.message).toContain("no client attached");
});

test("pane.capture of a sessionless plugin pane needs an attached client", async () => {
  const { daemon, env } = await started("cli-capture-plugin", { plugins: true });
  await waitFor(
    async () => {
      const status = await ctl(daemon.id, env, (c) => c.Status());
      return status.pluginHost?.state === "ready";
    },
    "plugin-host ready",
    30_000,
  );

  const { outputs } = await ctl(daemon.id, env, (c) =>
    c.Batch({
      values: [
        command("pane.open-plugin", {
          type: "amux.editor",
          descriptor: descriptorText({ file: "/x" }),
        }),
      ],
      context,
    }),
  );
  const pane = (outputs[0]!.result as { pane: string }).pane;

  const error = await ctl(daemon.id, env, (c) =>
    Effect.flip(c.Batch({ values: [command("pane.capture", { pane })] })),
  );
  expect(error._tag).toBe("ControlError");
  expect(error.message).toContain("no client attached");
  expect(error.message).not.toContain("has no session");
});
