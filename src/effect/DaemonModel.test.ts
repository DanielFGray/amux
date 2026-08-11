import { Cause, Effect, Ref } from "effect";
import { expect } from "bun:test";
import {
  DaemonModel,
  DaemonModelError,
  layerDaemonModel,
} from "./DaemonModel.ts";
import type { SessionState } from "../session.ts";
import { workspaceFromSession } from "../workspace.ts";
import { testEffect } from "../test-effect.ts";

const initial = {
  state: {
    version: 1 as const,
    id: "test",
    createdAt: 1,
    updatedAt: 1,
    attached: false,
    spaces: [],
  },
  workspace: Effect.runSync(
    workspaceFromSession({
      version: 1,
      id: "test",
      createdAt: 1,
      updatedAt: 1,
      attached: false,
      spaces: [],
    }),
  ),
};

testEffect("reads initial state and workspace", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    const s = yield* model.state;
    const w = yield* model.workspace;
    expect(s.id).toBe("test");
    expect(s.attached).toBe(false);
    expect(w.revision).toBe(0);
    expect(w.spaces).toEqual([]);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("enqueue preserves order", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    const order: number[] = [];
    yield* Effect.all(
      [1, 2, 3].map((n) =>
        model.enqueue(
          Effect.sync(() => {
            order.push(n);
          }),
        ),
      ),
      { concurrency: "unbounded" },
    );
    expect(order).toEqual([1, 2, 3]);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("enqueue serializes mutations", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    const counter = yield* Ref.make(0);
    const results = yield* Effect.all(
      Array.from({ length: 10 }, () =>
        model.enqueue(
          Ref.modify(counter, (n) => {
            const next = n + 1;
            return [next, next];
          }),
        ),
      ),
      { concurrency: "unbounded" },
    );
    expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("enqueue propagates typed errors", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    const result = yield* Effect.exit(
      model.enqueue(Effect.fail(new DaemonModelError({ message: "boom" }))),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause) as DaemonModelError;
      expect(error.message).toBe("boom");
    }
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("attach registers a client and updates state", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    let persisted: SessionState | null = null;

    yield* model.attach("client-a", "conn-1", (s) =>
      Effect.sync(() => {
        persisted = s;
      }),
    );

    expect(persisted).not.toBeNull();
    expect(persisted!.attached).toBe(true);

    const s = yield* model.state;
    expect(s.attached).toBe(true);

    const clients = yield* model.attachedClients;
    expect(clients).toEqual(["client-a"]);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("attach rejects duplicate connections", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    const noop = () => Effect.void;

    yield* model.attach("client-a", "conn-1", noop);
    const result = yield* Effect.exit(model.attach("client-b", "conn-1", noop));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause) as DaemonModelError;
      expect(error.message).toContain("already registered");
    }
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("detach removes a client and updates state", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    const noop = () => Effect.void;
    let detachPersisted: SessionState | null = null;

    yield* model.attach("client-a", "conn-1", noop);
    yield* model.detach("client-a", "conn-1", (s) =>
      Effect.sync(() => {
        detachPersisted = s;
      }),
    );

    expect(detachPersisted).not.toBeNull();
    expect(detachPersisted!.attached).toBe(false);

    const s = yield* model.state;
    expect(s.attached).toBe(false);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("detach of unknown client is a no-op", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    let persisted = false;
    yield* model.detach("unknown", "unknown", () =>
      Effect.sync(() => {
        persisted = true;
      }),
    );
    expect(persisted).toBe(false);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("touch updates attachLastSeen", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    const noop = () => Effect.void;

    yield* model.attach("client-a", "conn-1", noop);
    const before = yield* model.get;
    const beforeSeen = before.attachments.get("conn-1")!.attachLastSeen;

    yield* model.touch("client-a", "conn-1");

    const after = yield* model.get;
    expect(
      after.attachments.get("conn-1")!.attachLastSeen,
    ).toBeGreaterThanOrEqual(beforeSeen);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("touch is a no-op for unknown client", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    yield* model.touch("unknown", "unknown");
    const s = yield* model.get;
    expect(s.attachments.size).toBe(0);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("commitWorkspace updates workspace and state atomically", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    const next = yield* workspaceFromSession({
      version: 1,
      id: "test",
      createdAt: 1,
      updatedAt: 2,
      attached: true,
      spaces: [
        {
          id: "space-1",
          name: "new-space",
          dir: "/tmp",
          activeWindow: null,
          windows: [],
        },
      ],
    });

    yield* model.commitWorkspace(next, {
      version: 1,
      id: "test",
      createdAt: 1,
      updatedAt: 2,
      attached: true,
      spaces: [],
    });

    const w = yield* model.workspace;
    expect(w.spaces).toHaveLength(1);
    expect(w.spaces[0]!.name).toBe("new-space");
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("obligation bookkeeping tracks durable obligations", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;

    const sym = yield* model.addObligation("test obligation");
    const s = yield* model.get;
    expect(s.durableObligations.has(sym)).toBe(true);

    yield* model.updateObligation(sym, "updated detail");
    const updated = yield* model.get;
    expect(updated.durableObligations.get(sym)).toBe("updated detail");

    yield* model.clearObligation(sym);
    const cleared = yield* model.get;
    expect(cleared.durableObligations.has(sym)).toBe(false);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("multiple obligations are tracked independently", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;

    const a = yield* model.addObligation("first");
    const b = yield* model.addObligation("second");

    const s = yield* model.get;
    expect(s.durableObligations.size).toBe(2);

    yield* model.clearObligation(a);
    const after = yield* model.get;
    expect(after.durableObligations.size).toBe(1);
    expect(after.durableObligations.has(b)).toBe(true);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("markClosing sets closing flag", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    expect(yield* model.isClosing).toBe(false);
    yield* model.markClosing;
    expect(yield* model.isClosing).toBe(true);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("markCancelPersistence sets cancelPersistence flag", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    yield* model.markCancelPersistence;
    const s = yield* model.get;
    expect(s.cancelPersistence).toBe(true);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("heartbeat error is tracked", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    expect(yield* model.heartbeatError).toBeNull();

    yield* model.setHeartbeatError("lease failed");
    expect(yield* model.heartbeatError).toBe("lease failed");

    yield* model.setHeartbeatError(null);
    expect(yield* model.heartbeatError).toBeNull();
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);

testEffect("concurrent attaches are serialized", () =>
  Effect.gen(function* () {
    const model = yield* DaemonModel;
    const clients: string[] = [];

    yield* Effect.all(
      ["a", "b", "c"].map((c, i) =>
        model.attach(c, `conn-${i}`, () =>
          Effect.sync(() => {
            clients.push(c);
          }),
        ),
      ),
      { concurrency: "unbounded" },
    );

    expect(yield* model.attachedClients).toEqual(["a", "b", "c"]);
  }).pipe(Effect.provide(layerDaemonModel(initial))),
);
