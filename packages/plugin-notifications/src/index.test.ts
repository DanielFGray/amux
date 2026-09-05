import { afterEach } from "bun:test";
import { Effect, Exit } from "effect";
import { expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createPluginHost, type PluginHost } from "@danielfgray/amux/plugin/host.ts";
import {
  testPluginEnvironment,
  testPanelContext,
  testEffect,
  waitFor,
} from "@danielfgray/amux/testing";
import {
  resolveOptions,
  definePlugin,
  type PluginDefinition,
  type SidebarDisplayRow,
} from "@danielfgray/amux";
import {
  AgentAwarenessTag,
  type AgentAwarenessService,
} from "@danielfgray/amux-agent-awareness/presence.ts";
import notificationsPlugin from "./index.ts";

const cleanupFns: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanupFns.splice(0)) fn();
});

const REGISTRY_KEYS = ["amux/Options", "amux/Commands", "amux/Panel"];

const agentRow = (id: string): SidebarDisplayRow => ({
  kind: "agent",
  index: 0,
  spaceId: "s",
  spaceName: "s",
  active: false,
  agentId: id,
  exited: false,
});

function fakeAwarenessPlugin(presence: AgentAwarenessService["presence"]): PluginDefinition {
  return definePlugin({
    id: "test.agent-awareness",
    provide: [AgentAwarenessTag],
    effect: (ctx) => Effect.sync(() => ctx.provide(AgentAwarenessTag, { presence })),
  });
}

/** A host with core's Options/Commands/Panel registries live, over the given panel. */
const makeHost = Effect.fnUntraced(function* (panelParts: {
  readonly display: () => { rows: readonly SidebarDisplayRow[]; spaceCount: number };
  readonly blockedOption: boolean;
}) {
  const t = yield* Effect.promise(() => createTestRenderer({ width: 40, height: 10 }));
  cleanupFns.push(() => t.renderer.destroy());
  const panel = testPanelContext({
    display: panelParts.display,
    options: () => ({ ...resolveOptions({}), "notifications.blocked": panelParts.blockedOption }),
  });
  const environment = testPluginEnvironment(t.renderer, { panel });
  const host: PluginHost = yield* createPluginHost(environment);
  for (const key of REGISTRY_KEYS) {
    const entry = environment.registryEntries.find((candidate) =>
      candidate.provide?.some((provided) => provided.key === key),
    )!;
    yield* Effect.orDie(host.add(entry));
  }
  return host;
});

function spyOnBell() {
  let rings = 0;
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: Parameters<typeof original>[0], ...rest: unknown[]) => {
    if (chunk === "\x07") rings++;
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  cleanupFns.push(() => (process.stdout.write = original));
  return { rings: () => rings } satisfies { rings: () => number };
}

testEffect("rings once per transition into blocked presence", () =>
  Effect.gen(function* () {
    let blocked = false;
    const host = yield* makeHost({
      display: () => ({ rows: [agentRow("a1")], spaceCount: 1 }),
      blockedOption: true,
    });
    yield* Effect.orDie(
      host.add(
        fakeAwarenessPlugin((id) => ({
          session: id,
          agent: "claude",
          state: blocked ? "blocked" : "idle",
          source: "manifest",
          evidence: null,
        })),
      ),
    );
    yield* Effect.orDie(host.add(notificationsPlugin));

    const bell = spyOnBell();
    blocked = true;
    yield* Effect.promise(() =>
      waitFor(() => bell.rings() === 1, "the bell to ring once for the new block", 2_000),
    );
    // Staying blocked across further polls must not ring again.
    yield* Effect.sleep(250);
    expect(bell.rings()).toBe(1);
  }),
);

testEffect("does not ring while notifications.blocked is disabled", () =>
  Effect.gen(function* () {
    const host = yield* makeHost({
      display: () => ({ rows: [agentRow("a1")], spaceCount: 1 }),
      blockedOption: false,
    });
    yield* Effect.orDie(
      host.add(
        fakeAwarenessPlugin((id) => ({
          session: id,
          agent: "claude",
          state: "blocked",
          source: "manifest",
          evidence: null,
        })),
      ),
    );
    yield* Effect.orDie(host.add(notificationsPlugin));

    const bell = spyOnBell();
    yield* Effect.sleep(350);
    expect(bell.rings()).toBe(0);
  }),
);

testEffect("stays gated when nothing provides AgentAwarenessTag", () =>
  Effect.gen(function* () {
    const host = yield* makeHost({
      display: () => ({ rows: [], spaceCount: 0 }),
      blockedOption: true,
    });
    const result = yield* Effect.exit(host.add(notificationsPlugin));
    expect(Exit.isFailure(result)).toBe(true);
    expect(host.status().some((s) => s.id === notificationsPlugin.id)).toBe(false);
  }),
);
