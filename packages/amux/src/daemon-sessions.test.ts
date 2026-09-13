import { expect } from "bun:test";
import { Effect, Layer, Ref, Schema as S } from "effect";
import { testEffect } from "./test-effect.ts";
import { DaemonSessions, type DaemonSessionsService } from "./daemon-sessions.ts";
import { PromptOptionsSchema } from "./effect/SessionRegistry.ts";
import { PersistedSessionSchema } from "./session.ts";
import { CommandError, type RuntimeCommand } from "./commands.ts";
import {
  type DaemonCommandRegistration,
  type DaemonSessionCommandContext,
} from "./plugin/services.ts";
import { definePluginAction } from "./effect/WorkspaceTransaction.ts";
import type { JsonValue } from "./effect/AttachProtocol.ts";
import type { WorkspaceSnapshot } from "./workspace.ts";

const samplePersisted = {
  id: "s1",
  name: "s1",
  cmd: ["echo", "hi"],
  cols: 80,
  rows: 24,
  exited: false,
  exitCode: null,
};

const emptySnapshot: WorkspaceSnapshot = {
  revision: 0,
  spaces: [],
  state: { activeSpace: null, nextSpace: 1 },
};

testEffect("PersistedSessionSchema round-trips", () =>
  Effect.gen(function* () {
    const encoded = yield* S.encodeEffect(PersistedSessionSchema)(samplePersisted);
    const decoded = yield* S.decodeEffect(PersistedSessionSchema)(encoded);
    expect(decoded).toEqual(samplePersisted);
  }),
);

testEffect("PromptOptionsSchema round-trips", () =>
  Effect.gen(function* () {
    const value = {
      id: "turn-1",
      delivery: "steer" as const,
      resume: true,
      replace: "old",
    };
    const encoded = yield* S.encodeEffect(PromptOptionsSchema)(value);
    const decoded = yield* S.decodeEffect(PromptOptionsSchema)(encoded);
    expect(decoded).toEqual(value);
  }),
);

interface Tracked {
  prompted: { target: string; text: string }[];
  captured: string[];
  messages: { id: string; message: JsonValue }[];
}

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

const probePromptCommand: DaemonCommandRegistration = {
  tag: "probe.prompt",
  fields: { target: S.String, text: S.String },
  meta: {
    desc: "probe",
    group: "test",
    target: "session",
    exposure: "human",
  },
  resources: () => [],
  run: (command: RuntimeCommand, _context: DaemonSessionCommandContext) =>
    Effect.gen(function* () {
      if (typeof command.target !== "string" || typeof command.text !== "string") {
        return yield* new CommandError({ message: "bad args" });
      }
      const sessions = yield* DaemonSessions;
      yield* sessions
        .prompt(command.target, command.text)
        .pipe(Effect.mapError((error) => new CommandError({ message: error.message })));
      const screen = yield* sessions
        .capture(command.target)
        .pipe(Effect.mapError((error) => new CommandError({ message: error.message })));
      return screen;
    }),
};

const ProbeMessage = S.TaggedStruct("probe.message", {
  agent: S.String,
  body: S.String,
});

const probeMessageAction = definePluginAction({
  tag: "probe.message",
  payload: ProbeMessage,
  execute: (action) =>
    Effect.gen(function* () {
      const sessions = yield* DaemonSessions;
      yield* sessions.message(action.agent, { body: action.body });
    }),
});

testEffect("session-target command reaches prompt and capture through DaemonSessions", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make<Tracked>({
      prompted: [],
      captured: [],
      messages: [],
    });
    const result = yield* probePromptCommand.run!(
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
    yield* probeMessageAction
      .run({
        _tag: "probe.message",
        payload: { _tag: "probe.message", agent: "a1", body: "hi" },
      })
      .pipe(Effect.provide(trackingLayer(state)));
    const tracked = yield* Ref.get(state);
    expect(tracked.messages).toEqual([{ id: "a1", message: { body: "hi" } }]);
  }),
);
