/** @jsxImportSource @opentui/solid */
/** @effect-diagnostics *:skip-file -- Solid render-tree event handlers and lifecycle control flow belong to OpenTUI/Solid, not the service Effect graph. */
import { createSignal, Show } from "solid-js";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Path, Scope } from "effect";
import type { KeyEvent } from "@opentui/core";
import {
  CONTEXT_PRIORITY,
  ContextsTag,
  CurrentPlugin,
  PanelTag,
  SlotsTag,
  command,
  runtimeCommand,
  type ContextSpec,
  type OverlayOccupant,
  type WorkspaceSnapshot,
} from "@danielfgray/amux";
import { projectRoot } from "@danielfgray/amux/git.ts";
import {
  conversationPreview,
  layer as projectStoreLayer,
  Service as ProjectStore,
  type ConversationRecord,
} from "@danielfgray/amux/project-store.ts";
import {
  filterEntries as filterPickerEntries,
  ModalPicker,
  type CompletionItem,
} from "@danielfgray/amux-plugin-completion";

export type SessionPickerKind = "live" | "exited" | "stored";

export interface SessionPickerEntry {
  readonly value: string;
  readonly kind: SessionPickerKind;
  readonly label: string;
  readonly detail: string;
  /** Conversation `updated` ms, or 0 when unknown — newest first in the list. */
  readonly updated: number;
}

export interface SessionPickerView {
  readonly allEntries: readonly SessionPickerEntry[];
  readonly entries: readonly SessionPickerEntry[];
  readonly query: string;
  readonly selected: number;
}

/**
 * Overlay twin of ModelPicker for `/sessions`: resume a live native agent,
 * restart an exited one, or recreate a stored agent id in-place (`resumeFrom`)
 * so conversation + AgentLog (chat transcript) both come back.
 */
export const registerSessionPicker: Effect.Effect<
  Effect.Effect<void>,
  never,
  SlotsTag | ContextsTag | PanelTag | CurrentPlugin | Scope.Scope
> = Effect.gen(function* () {
  const panel = yield* PanelTag;
  const [view, setView] = createSignal<SessionPickerView | null>(null);

  const choose = () => {
    const current = view();
    const entry = current?.entries[current.selected];
    if (!entry) return;
    setView(null);
    const report = (effect: Effect.Effect<unknown, { readonly message: string }>) =>
      Effect.runFork(
        effect.pipe(Effect.catch((error) => Effect.sync(() => panel.reportError(error.message)))),
      );
    if (entry.kind === "live") {
      report(panel.run(command("session.reveal", { target: entry.value })));
      return;
    }
    if (entry.kind === "exited") {
      report(
        panel.run(command("session.restart", { target: entry.value })).pipe(
          Effect.andThen(() => panel.run(command("session.reveal", { target: entry.value }))),
        ),
      );
      return;
    }
    report(
      panel.run(
        runtimeCommand("agent.new", {
          provider: "native",
          here: true,
          resumeFrom: entry.value,
        }),
      ),
    );
  };

  function keys(event: KeyEvent): boolean {
    if (!view()) return true;
    switch (event.name) {
      case "escape":
        setView(null);
        return true;
      case "j":
      case "down":
        setView((v) => v && { ...v, selected: Math.min(v.entries.length - 1, v.selected + 1) });
        return true;
      case "k":
      case "up":
        setView((v) => v && { ...v, selected: Math.max(0, v.selected - 1) });
        return true;
      case "return":
      case "enter":
        choose();
        return true;
    }
    return false;
  }

  const slots = yield* SlotsTag;
  const contexts = yield* ContextsTag;
  const runtime = yield* Effect.context();
  const occupant: OverlayOccupant = {
    id: "amux.agent-harness.session-picker",
    title: "session picker",
    visible: () => view() !== null,
    component: (props) => (
      <Show when={view()}>
        {(current: () => SessionPickerView) => (
          <ModalPicker
            view={sessionPickerView(current())}
            width={props.width}
            title=" resume native agent session "
            filterPlaceholder="filter sessions"
            onInput={(query) => setView((v) => v && filterEntries(v, query))}
            onPick={(selected) => {
              setView((v) => v && { ...v, selected });
              choose();
            }}
            onSubmit={choose}
          />
        )}
      </Show>
    ),
  };
  let overlayReady = false;
  const ensureOverlay = () => {
    if (overlayReady) return;
    overlayReady = true;
    Effect.runForkWith(runtime)(
      slots.register({
        slot: "overlay",
        occupant,
        priority: 15,
      }),
    );
  };
  const context: ContextSpec = {
    id: "amux.agent-harness.session-picker",
    active: () => view() !== null,
    priority: CONTEXT_PRIORITY.OVERLAY + 15,
    rebindable: false,
    handle: keys,
  };
  yield* contexts.register(context);

  return yield* Effect.succeed(
    Effect.gen(function* () {
      const snapshot = panel.snapshot();
      const cwd = activeSpaceDir(snapshot) ?? process.cwd();
      const stored = yield* listStoredConversations(cwd).pipe(
        Effect.orElseSucceed(() => [] as readonly ConversationRecord[]),
      );
      const entries = sessionEntries(snapshot, stored);
      setView({
        allEntries: entries,
        entries,
        query: "",
        selected: 0,
      });
      ensureOverlay();
    }),
  );
});

export function sessionEntries(
  snapshot: WorkspaceSnapshot,
  stored: readonly ConversationRecord[],
): SessionPickerEntry[] {
  const updatedById = new Map(stored.map((row) => [row.session, row.updated]));
  const byId = new Map<string, SessionPickerEntry>();
  for (const { session, space } of workspaceNativeSessions(snapshot)) {
    const kind: SessionPickerKind = session.exited ? "exited" : "live";
    byId.set(session.id, {
      value: session.id,
      kind,
      label: `${kindMarker(kind)} ${session.name || session.id}`,
      detail: `${space.name ?? space.id} · ${session.id}`,
      updated: updatedById.get(session.id) ?? 0,
    });
  }
  for (const row of stored) {
    if (byId.has(row.session)) {
      const existing = byId.get(row.session)!;
      byId.set(row.session, {
        ...existing,
        updated: row.updated,
        detail: `${existing.detail} · ${conversationPreview(row.conversation)}`,
      });
      continue;
    }
    byId.set(row.session, {
      value: row.session,
      kind: "stored",
      label: `${kindMarker("stored")} ${row.session}`,
      detail: `${formatUpdated(row.updated)} · ${conversationPreview(row.conversation)}`,
      updated: row.updated,
    });
  }
  return [...byId.values()].sort((a, b) => {
    // Newest conversations first; unknown dates sink below dated rows.
    if (a.updated !== b.updated) return b.updated - a.updated;
    const rank = (kind: SessionPickerKind) =>
      kind === "live" ? 0 : kind === "exited" ? 1 : 2;
    return rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label);
  });
}

export function filterEntries(view: SessionPickerView, query: string): SessionPickerView {
  return filterPickerEntries(view, query, (entry) => `${entry.label} ${entry.detail} ${entry.value}`);
}

const sessionPickerView = (view: SessionPickerView) => ({
  ...view,
  allEntries: view.allEntries.map(sessionPickerItem),
  entries: view.entries.map(sessionPickerItem),
});

const sessionPickerItem = (entry: SessionPickerEntry): CompletionItem => ({
  id: entry.value,
  label: entry.label,
  detail: entry.detail,
  replacement: entry.value,
});

const kindMarker = (kind: SessionPickerKind): string => {
  switch (kind) {
    case "live":
      return "●";
    case "exited":
      return "○";
    case "stored":
      return "◇";
  }
};

const formatUpdated = (updated: number): string => {
  try {
    return new Date(updated).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return String(updated);
  }
};

function* workspaceNativeSessions(snapshot: WorkspaceSnapshot): Generator<{
  readonly session: WorkspaceSnapshot["spaces"][number]["windows"][number]["sessions"][number];
  readonly space: WorkspaceSnapshot["spaces"][number];
}> {
  for (const space of snapshot.spaces) {
    for (const window of space.windows) {
      for (const session of window.sessions) {
        if (session.kind === "component" && session.provider === "native") {
          yield { session, space };
        }
      }
    }
  }
}

const activeSpaceDir = (snapshot: WorkspaceSnapshot): string | undefined => {
  const activeId = snapshot.state.activeSpace;
  const active =
    activeId !== null ? snapshot.spaces.find((space) => space.id === activeId) : undefined;
  return (active ?? snapshot.spaces[0])?.dir;
};

const listStoredConversations = (cwd: string) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => projectRoot(cwd));
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* ProjectStore;
        return yield* store.listConversations;
      }).pipe(
        Effect.provide(
          projectStoreLayer(root).pipe(
            Layer.provide(BunFileSystem.layer),
            Layer.provide(Path.layer),
          ),
        ),
      ),
    );
  });
