import { expect } from "bun:test";
import { Effect } from "effect";
import { testEffect } from "@danielfgray/amux/testing";
import type { WorkspaceDraft } from "@danielfgray/amux";
import { agentHarnessDaemonCommands } from "./daemon.ts";

const agentNew = agentHarnessDaemonCommands.find((c) => c.tag === "agent.new")!;

// `session` and `sessionOps` are typed off `onSessionLive` itself rather than
// imported by name: their real types (PersistedSession, SessionOps) are
// internal to core and not part of the plugin package's public export surface.
type OnSessionLive = NonNullable<typeof agentNew.onSessionLive>;
type LiveSession = Parameters<OnSessionLive>[0];
type LiveSessionOps = Parameters<OnSessionLive>[1];
type LiveSessionCalls = Array<{ id: string; message: Parameters<LiveSessionOps["message"]>[1] }>;

const context = { cwd: "/tmp", shell: ["sh"], size: { cols: 80, rows: 24 } };

/** A stand-in for core's real reducer draft, implementing only what
 *  agentNew.reduce actually calls. */
function fakeDraft() {
  let added: LiveSession | undefined;
  const draft: WorkspaceDraft = {
    activeWindow: () => ({ window: {} as never, space: { dir: "/tmp" } as never }),
    findSession: () => Effect.die("not used") as never,
    addSession: (_target, dir, opts) => {
      added = {
        id: "component-session",
        provider: opts?.provider,
        name: "test-agent",
        cwd: dir,
        cols: 80,
        rows: 24,
        exited: false,
        exitCode: null,
      } as never;
      return added as never;
    },
    placeSessionPane: () => "pane-1",
    pushAction: () => {},
    setResult: () => {},
    listAgents: () => [],
    getAgent: () => null,
  };
  return { draft, added: () => added };
}

const fakeSessionOps = (calls: LiveSessionCalls): LiveSessionOps => ({
  prepare: () => Effect.die("not used"),
  kill: () => Effect.die("not used"),
  write: () => Effect.die("not used"),
  message: (id, message) =>
    Effect.sync(() => {
      calls.push({ id, message });
    }),
  pids: Effect.die("not used"),
});

/* A component session's spawn is deferred (a client calls resumeAgent later,
 * long after reduce runs), so a prompt handed to agent.new has to survive
 * until then somewhere other than core's action list — core has no "prompt"
 * action at all (see workspace.test.ts's sibling assertion). This is the
 * seam that used to silently drop `--prompt`. */
testEffect("agent.new's onSessionLive delivers the prompt queued at reduce time, once", () =>
  Effect.gen(function* () {
    const { draft, added } = fakeDraft();
    agentNew.reduce!(
      draft,
      { _tag: "agent.new", provider: "test", prompt: "Inspect this" },
      context,
    );
    const session = added()!;

    const calls: LiveSessionCalls = [];
    const sessionOps = fakeSessionOps(calls);

    yield* agentNew.onSessionLive!(session, sessionOps);
    expect(calls).toEqual([
      { id: session.id, message: { _tag: "agent.prompt", text: "Inspect this" } },
    ]);

    // A second resumeAgent (or a plugin restart's re-registration) must not
    // replay the same prompt — it was drained, not merely read.
    yield* agentNew.onSessionLive!(session, sessionOps);
    expect(calls).toHaveLength(1);
  }),
);

testEffect("agent.new's onSessionLive is a no-op for a session with no queued prompt", () =>
  Effect.gen(function* () {
    const { draft, added } = fakeDraft();
    agentNew.reduce!(draft, { _tag: "agent.new", provider: "test" }, context);
    const session = added()!;

    const calls: LiveSessionCalls = [];
    const sessionOps = fakeSessionOps(calls);

    yield* agentNew.onSessionLive!(session, sessionOps);
    expect(calls).toEqual([]);
  }),
);
