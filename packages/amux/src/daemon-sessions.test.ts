import { Effect, Layer, Ref, Schema as S } from "effect";
import { expect } from "bun:test";
import { testEffect } from "./testing.ts";
import { DaemonSessions, type DaemonSessionsService } from "./daemon-sessions.ts";
import { defineDaemonCommand, definePluginAction } from "./api.ts";
import { CommandError } from "./commands.ts";
import type { WorkspaceSnapshot } from "./workspace.ts";
import type { OwnerJsonText } from "./layout.ts";
import { encodeOwner } from "./workspace-change-builders.ts";

type Tracked = {
  readonly prompted: readonly { readonly target: string; readonly text: string }[];
  readonly captured: readonly string[];
  readonly messages: readonly { readonly id: string; readonly message: OwnerJsonText }[];
};

const emptySnapshot: WorkspaceSnapshot = {
  revision: 0,
  spaces: [],
  state: { activeSpace: null, nextSpace: 1 },
};

const trackingLayer = (state: Ref.Ref<Tracked>) => {
  const service: DaemonSessionsService = {
    message: (id, message) =>
      Ref.update(state, (s) => ({
        ...s,
        messages: [...s.messages, { id, message }],
      })),
    prompt: (target, text) =>
      Ref.update(state, (s) => ({
        ...s,
        prompted: [...s.prompted, { target, text }],
      })),
    capture: (session) =>
      Ref.update(state, (s) => ({
        ...s,
        captured: [...s.captured, session],
      })).pipe(Effect.as("screen")),
  };
  return Layer.succeed(DaemonSessions, service);
};

const probePromptCommand = defineDaemonCommand({
  tag: "probe.prompt",
  fields: S.Struct({ target: S.String, text: S.String }),
  meta: {
    desc: "probe",
    group: "test",
    target: "session",
    exposure: "human",
  },
  resources: () => [],
  run: (command, _context) =>
    Effect.gen(function* () {
      const sessions = yield* DaemonSessions;
      yield* sessions
        .prompt(command.target, command.text)
        .pipe(Effect.mapError((error) => new CommandError({ message: error.message })));
      const screen = yield* sessions
        .capture(command.target)
        .pipe(Effect.mapError((error) => new CommandError({ message: error.message })));
      return screen;
    }),
});

const ProbeMessage = S.TaggedStruct("probe.message", {
  agent: S.String,
  body: S.String,
});

const encodeProbeMessage = encodeOwner(ProbeMessage, "probe.message");

const probeMessageAction = definePluginAction({
  tag: "probe.message",
  payload: ProbeMessage,
  execute: (action) =>
    Effect.gen(function* () {
      const sessions = yield* DaemonSessions;
      yield* sessions.message(action.agent, yield* encodeProbeMessage(action));
    }),
});

testEffect("session-target command reaches prompt and capture through DaemonSessions", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make<Tracked>({
      prompted: [],
      captured: [],
      messages: [],
    });
    const run = probePromptCommand.run;
    if (run === undefined) return yield* new CommandError({ message: "missing run" });
    const result = yield* run(
      { _tag: "probe.prompt", target: "a1", text: "hello" },
      { snapshot: emptySnapshot },
    ).pipe(Effect.provide(trackingLayer(state)));
    expect(result).toBe("screen");
    const tracked = yield* Ref.get(state);
    expect(tracked.prompted).toEqual([{ target: "a1", text: "hello" }]);
    expect(tracked.captured).toEqual(["a1"]);
  }),
);

testEffect("plugin action reaches message through DaemonSessions", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make<Tracked>({
      prompted: [],
      captured: [],
      messages: [],
    });
    const payload = yield* encodeProbeMessage({
      _tag: "probe.message",
      agent: "a1",
      body: "hi",
    });
    yield* probeMessageAction
      .run({
        _tag: "probe.message",
        payload,
      })
      .pipe(Effect.provide(trackingLayer(state)));
    const tracked = yield* Ref.get(state);
    expect(tracked.messages).toEqual([{ id: "a1", message: payload }]);
  }),
);
