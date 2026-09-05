/** @jsxImportSource @opentui/solid */
/**
 * The slot registry: replaces ui/regions.tsx's fixed 10-slot chrome API with
 * an open-ended one. See CONTEXT.md ("Slot", "Slot occupant", "Frame",
 * "Pane-host slot", "Tiling algorithm") and docs/adr/0001 and 0002 for the
 * design this implements.
 *
 * INTERFACE CONTRACT — implemented by codex in this file. Consumer
 * migrations (plugin-sidebar, ModelPicker, app.tsx's core panels, examples)
 * are being written against this file concurrently by opencode; do not
 * rename exported symbols without flagging it, since both sides depend on
 * this shape as-is.
 */
import { Show, createComponent, type JSX } from "solid-js";
import type { BoxRenderable, CliRenderer, KeyEvent } from "@opentui/core";
import { createSlot, createSolidSlotRegistry, type SolidPlugin } from "@opentui/solid";
import { Effect, Schema as S } from "effect";
import { Divider } from "../divider.ts";
import type { PluginContributions, PluginInstance } from "../plugin/contributions.ts";
import type { DockSide } from "../layout.ts";
import { App, type AppProps } from "./App.tsx";
export type { DockSide } from "../layout.ts";

interface NativeSlotProps {
  readonly [key: string]:
    | string
    | number
    | BoxRenderable
    | SlotReader
    | { readonly width: number; readonly height: number }
    | undefined;
}
interface NativeSlotContext {}
interface NativeSlots {
  readonly [slot: string]: NativeSlotProps;
}
interface RootSlotProps extends NativeSlotProps, AppProps {}

/**
 * The chrome-occupant content shapes. These are today's ui/regions.tsx
 * DockPanel/OverlayPanel/FloatPanel, relocated and renamed as the payload a
 * plugin's `SlotRegistration.content` carries — unchanged field-for-field so
 * migrating a consumer is a rename + reshape of the register() call, not a
 * rewrite of the panel's own render logic. FIXED CONTRACT: both the registry
 * implementation and every consumer migration are written against these
 * exact shapes; do not change field names without updating both sides.
 */
export type Anchor = "app" | "center";
export type DockSlotName = `${DockSide}.${Anchor}`;

export interface DockSlotProps {
  side: DockSide;
  anchor: Anchor;
}
export interface OverlaySlotProps {
  width: number;
  height: number;
}
export interface FloatSlotProps {
  left: number;
  width: number;
  height: number;
}

interface ChromeOccupantBase {
  id: string;
  title?: string;
  visible?: () => boolean;
}

/** Registers into a `${DockSide}.${Anchor}` slot (kind: "list"). */
export interface DockOccupant extends ChromeOccupantBase {
  size: () => number;
  minSize?: number;
  resizable?: boolean;
  onResize?: (delta: number) => void;
  component: (props: DockSlotProps) => JSX.Element;
}

/** Registers into the "overlay" slot (kind: "list"; stacking order = priority). */
export interface OverlayOccupant extends ChromeOccupantBase {
  keys?: (event: KeyEvent) => boolean;
  component: (props: OverlaySlotProps) => JSX.Element;
}

/** Registers into the "float" slot (kind: "list"). */
export interface FloatOccupant extends ChromeOccupantBase {
  component: (props: FloatSlotProps) => JSX.Element;
}

export type ChromeOccupant = DockOccupant | OverlayOccupant | FloatOccupant;

export type SlotKind = "single" | "keyed" | "list" | "chain";

/** A slot is declared (name + kind) before anything can register into it.
 *  The root slot is the one host-seeded exception. */
export interface SlotDeclaration {
  name: string;
  kind: SlotKind;
}

/** Live render/selection context a chain-kind slot's candidates select against. */
export interface SlotContext {
  width: number;
  height: number;
  workspaceId?: string;
  sessionCount?: number;
}

interface RegistrationBase {
  slot: string;
  /** Ascending: lower wins a same-priority-tier ordering; lower number =
   *  rendered first / preferred. Config may override this per (plugin, slot)
   *  pair — see `withPriorityOverride`. */
  priority: number;
  /** New child slot names this occupant declares while occupying `slot`.
   *  "Declaring is claiming": redeclaring an existing name throws, naming
   *  the first declarer. For a `chain`-kind slot's occupant, declared
   *  children exist only while this occupant is elected (ADR 0001) — they
   *  are retracted and re-declared as election changes, not declared once
   *  at register() time. */
  children?: SlotDeclaration[];
}

export interface SingleOrKeyedOrListRegistration<TContent = unknown> extends RegistrationBase {
  /** Required for a `keyed`-kind slot; ignored for single/list. */
  key?: string;
  content: TContent;
}

export interface ChainRegistration<TContent = unknown> extends RegistrationBase {
  /** Pure: called with live context each render. First matching candidate,
   *  in priority order, is elected. */
  selector: (ctx: SlotContext) => boolean;
  content: TContent;
}

export type SlotRegistration<TContent = unknown> =
  | SingleOrKeyedOrListRegistration<TContent>
  | ChainRegistration<TContent>;

/**
 * Thrown when a same-priority registration collides with an already-occupied
 * single/keyed cell, or when `children` redeclares a name some other
 * occupant already declared. Names the existing occupant/declarer.
 */
export class SlotConflictError extends S.TaggedError<SlotConflictError>()("SlotConflictError", {
  slot: S.String,
  occupantId: S.String,
  message: S.String,
}) {}

/** One live registration in a `SlotSnapshotNode`, for diagnostics. */
export interface SlotSnapshotEntry {
  id: string;
  owner: string;
  /** The priority the registrant declared; `order` is what it resolved to
   *  after config overrides. */
  priority: number;
  order: number;
  /** True only on a chain-kind slot's currently elected entry. */
  elected: boolean;
}

/** One slot's live subtree, for diagnostics: its declaration, the entries
 *  currently registered in it, and the child slots its occupants declare —
 *  nested recursively, so the whole declaration tree reads off one value. */
export interface SlotSnapshotNode {
  name: string;
  kind: SlotKind;
  owner: string;
  entries: SlotSnapshotEntry[];
  /** The elected entry's id on a chain-kind slot, else null. */
  elected: string | null;
  children: SlotSnapshotNode[];
}

export interface SlotRegistry {
  /** Declare a new slot. Throws SlotConflictError if `name` is already
   *  declared by a different owner. */
  declare(owner: PluginInstance, decl: SlotDeclaration): void;
  /**
   * Register an occupant into a slot. Returns a disposer.
   *
   * Failure is scoped to this one registration: a losing single/keyed
   * collision or an errored chain candidate reports through the same
   * onPluginError channel regions.tsx used, and register() returns a no-op
   * disposer — it never refuses the owning plugin's other capabilities.
   */
  register<TContent>(owner: PluginInstance, entry: SlotRegistration<TContent>): () => void;
  /** The elected/resolved occupant(s) for a slot right now, given live
   *  context (only meaningful for chain-kind; single/keyed/list resolve
   *  without context). */
  resolve<TContent>(slot: string, ctx?: SlotContext): TContent[];
  /** The live declaration tree, for diagnostics: the root slots (those no
   *  live occupant declares as a child) with their subtrees nested. */
  snapshot(): SlotSnapshotNode[];
}

/**
 * The plugin-facing chrome API — replaces ui/regions.tsx's `Regions`
 * interface. FIXED CONTRACT for this migration: both the registry
 * implementation (codex) and consumer migrations (opencode) call this
 * exact shape. `register`'s slot argument fixes which ChromeOccupant
 * subtype is valid, mirroring how DockPanel/OverlayPanel/FloatPanel used to
 * be discriminated by a `region` field — here the slot name IS the
 * discriminant, passed alongside the occupant rather than embedded in it.
 */
export interface Slots {
  register(
    owner: PluginInstance,
    slot: DockSlotName,
    occupant: DockOccupant,
    priority?: number,
  ): () => void;
  register(
    owner: PluginInstance,
    slot: "overlay",
    occupant: OverlayOccupant,
    priority?: number,
  ): () => void;
  register(
    owner: PluginInstance,
    slot: "float",
    occupant: FloatOccupant,
    priority?: number,
  ): () => void;
  /** The slot component the layout renders (same role as regions.tsx's Slot). */
  Slot: unknown;
  declared: (side: DockSide, anchor: Anchor) => boolean;
  thickness: (side: DockSide, anchor: Anchor) => number;
  divider: (side: DockSide, anchor: Anchor) => import("../divider.ts").Divider | null;
  topOverlay: () => OverlayOccupant | null;
}

export type SlotReader = Omit<Slots, "register">;

export interface SlotRegistryOptions {
  onPluginError?: (event: { pluginId: string; slot?: string; phase: string; error: Error }) => void;
  /** Config-supplied priority overrides, keyed by `${pluginId}:${slotName}`,
   *  applied instead of a plugin's own declared priority at registration
   *  time (ts-789dd7's config-override decision). */
  priorityOverrides?: Record<string, number>;
}

/**
 * TODO(codex): implement. See docs/adr/0001 and 0002, and CONTEXT.md's
 * Slot/Slot occupant/Frame/Pane-host slot/Tiling algorithm entries for the
 * full behavioral spec: kind-specific collision rules, chain election +
 * lazy child declaration, config priority override, snapshot diagnostics.
 *
 * Root slot: seed a `chain`-kind slot named "root" here at registry
 * construction time (host-seeded, not declared by a plugin).
 */
export function createSlotRegistry(
  renderer: CliRenderer,
  contributions: PluginContributions,
  options?: SlotRegistryOptions,
): SlotRegistry {
  type Entry = SlotRegistration & { owner: PluginInstance; id: string; order: number };
  type Declared = SlotDeclaration & { owner: PluginInstance };

  const native = createSolidSlotRegistry<NativeSlots, NativeSlotContext>(
    renderer,
    {},
    {
      onPluginError: (event) =>
        options?.onPluginError?.({
          pluginId: event.pluginId,
          slot: event.slot,
          phase: event.phase,
          error: event.error,
        }),
    },
  );
  const slots = new Map<string, { declaration: Declared; entries: Entry[] }>();
  const nativeDisposers = new Map<string, Map<string, () => void>>();
  let nextEntryId = 0;
  const rootOwner: PluginInstance = { id: "amux.host", generation: 0 };
  slots.set("root", {
    declaration: { name: "root", kind: "chain", owner: rootOwner },
    entries: [],
  });

  const idOf = (entry: Entry) =>
    `${entry.owner.id}#${entry.owner.generation}:${entry.slot}:${entry.id}`;
  const occupantId = (entry: Entry | undefined) => entry?.id ?? "unknown";
  const report = (entry: Entry, phase: string, error: Error) =>
    options?.onPluginError?.({
      pluginId: entry.owner.id,
      slot: entry.slot,
      phase,
      error,
    });
  const ownerFor = (owner: PluginInstance, slot: string) =>
    options?.priorityOverrides?.[`${owner.id}:${slot}`];

  const ordered = (slot: { declaration: SlotDeclaration; entries: Entry[] }, ctx?: SlotContext) => {
    const entries = slot.entries
      .filter((entry) =>
        slot.declaration.kind === "chain"
          ? (entry as ChainRegistration).selector(
              ctx ?? { width: renderer.width, height: renderer.height },
            )
          : true,
      )
      .sort((a, b) => a.order - b.order || a.owner.id.localeCompare(b.owner.id));
    if (slot.declaration.kind === "chain" || slot.declaration.kind === "single")
      return entries.slice(0, 1);
    if (slot.declaration.kind === "keyed") {
      const byKey = new Map<string | undefined, Entry>();
      for (const entry of entries)
        if (!byKey.has((entry as { key?: string }).key))
          byKey.set((entry as { key?: string }).key, entry);
      return [...byKey.values()];
    }
    return entries;
  };

  const retractChildren = (entry: Entry) => {
    for (const child of entry.children ?? []) {
      const found = slots.get(child.name);
      if (found?.declaration.owner === entry.owner) slots.delete(child.name);
    }
  };
  const declareChildren = (entry: Entry) => {
    for (const child of entry.children ?? []) {
      const found = slots.get(child.name);
      if (found) {
        throw new SlotConflictError({
          slot: child.name,
          occupantId: found.declaration.owner.id,
          message: `slot '${child.name}' is already declared by '${found.declaration.owner.id}'`,
        });
      }
      slots.set(child.name, { declaration: { ...child, owner: entry.owner }, entries: [] });
    }
  };
  const sync = (name: string) => {
    const slot = slots.get(name);
    if (!slot) return;
    const winners = new Set(ordered(slot).map(idOf));
    const disposers = nativeDisposers.get(name) ?? new Map<string, () => void>();
    nativeDisposers.set(name, disposers);
    for (const [id, dispose] of disposers) {
      if (!winners.has(id)) {
        dispose();
        disposers.delete(id);
      }
    }
    for (const entry of ordered(slot)) {
      const id = idOf(entry);
      if (disposers.has(id)) continue;
      const plugin: SolidPlugin<NativeSlots> = {
        id,
        order: entry.order,
        slots: {
          [name]: (_ctx: NativeSlotContext, props: NativeSlotProps) =>
            typeof entry.content === "function"
              ? (entry.content as (ctx: NativeSlotContext, props: NativeSlotProps) => JSX.Element)(
                  _ctx,
                  props,
                )
              : (entry.content as JSX.Element),
        },
      };
      disposers.set(id, native.register(plugin));
    }
  };

  // TODO: subscribe renderer resize events and re-sync chain slots when a
  // second frame or other responsive chain candidate exists.

  const api: SlotRegistry & { readonly _slot: unknown; readonly _native: typeof native } = {
    declare(owner, decl) {
      const found = slots.get(decl.name);
      if (found) {
        throw new SlotConflictError({
          slot: decl.name,
          occupantId: found.declaration.owner.id,
          message: `slot '${decl.name}' is already declared by '${found.declaration.owner.id}'`,
        });
      }
      slots.set(decl.name, { declaration: { ...decl, owner }, entries: [] });
    },
    register(owner, entry) {
      const slot = slots.get(entry.slot);
      if (!slot) throw new Error(`slot '${entry.slot}' has not been declared`);
      const order = ownerFor(owner, entry.slot) ?? entry.priority;
      const id = `${owner.id}:${owner.generation}:${nextEntryId++}`;
      const stored = { ...entry, owner, id, order } as Entry;
      if (
        slot.declaration.kind === "single" &&
        slot.entries.some((candidate) => candidate.order === order)
      ) {
        const existing = slot.entries.find((candidate) => candidate.order === order);
        throw new SlotConflictError({
          slot: entry.slot,
          occupantId: occupantId(existing),
          message: `slot '${entry.slot}' priority ${order} conflicts with '${occupantId(existing)}'`,
        });
      }
      if (
        slot.declaration.kind === "keyed" &&
        slot.entries.some(
          (candidate) =>
            candidate.order === order &&
            (candidate as { key?: string }).key === (entry as { key?: string }).key,
        )
      ) {
        const existing = slot.entries.find(
          (candidate) =>
            candidate.order === order &&
            (candidate as { key?: string }).key === (entry as { key?: string }).key,
        );
        throw new SlotConflictError({
          slot: entry.slot,
          occupantId: occupantId(existing),
          message: `slot '${entry.slot}' key '${(entry as { key?: string }).key}' priority ${order} conflicts with '${occupantId(existing)}'`,
        });
      }
      try {
        if (slot.declaration.kind !== "chain") declareChildren(stored);
      } catch (error) {
        report(stored, "declare", error instanceof Error ? error : new Error(String(error)));
        return () => {};
      }
      const previousElected = slot.declaration.kind === "chain" ? ordered(slot)[0] : undefined;
      slot.entries.push(stored);
      const elected = slot.declaration.kind === "chain" ? ordered(slot)[0] : undefined;
      if (previousElected !== elected) {
        if (previousElected) retractChildren(previousElected);
        try {
          if (elected) declareChildren(elected);
        } catch (error) {
          slot.entries.splice(slot.entries.indexOf(stored), 1);
          if (previousElected) declareChildren(previousElected);
          report(stored, "declare", error instanceof Error ? error : new Error(String(error)));
          return () => {};
        }
      }
      sync(entry.slot);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        // Election is a chain-kind concept only (ADR 0001): a list/keyed
        // entry's children are its own, retracted with it, and there is no
        // "next winner" to re-declare. Gating on kind keeps a disposed
        // sibling from touching another entry's live children.
        if (slot.declaration.kind !== "chain") {
          retractChildren(stored);
          slot.entries.splice(slot.entries.indexOf(stored), 1);
          sync(entry.slot);
          return;
        }
        const wasElected = ordered(slot)[0] === stored;
        if (wasElected) retractChildren(stored);
        slot.entries.splice(slot.entries.indexOf(stored), 1);
        const next = ordered(slot)[0];
        if (next && next !== stored) {
          try {
            declareChildren(next);
          } catch (error) {
            report(next, "declare", error instanceof Error ? error : new Error(String(error)));
          }
        }
        sync(entry.slot);
      };
    },
    resolve<TContent>(slot: string, ctx?: SlotContext): TContent[] {
      const found = slots.get(slot);
      return found ? ordered(found, ctx).map((entry) => entry.content as TContent) : [];
    },
    snapshot() {
      // A slot's parent is the live occupant that declares it: for a
      // chain-kind slot only the elected entry's children are live (ADR
      // 0001), for every other kind each entry's children are its own.
      const liveDeclarer = (
        parent: { declaration: Declared; entries: Entry[] },
        entry: Entry,
      ): boolean => (parent.declaration.kind === "chain" ? ordered(parent)[0] === entry : true);
      const parentOf = (child: string): string | null => {
        const found = slots.get(child);
        if (!found) return null;
        for (const [name, parent] of slots) {
          if (name === child) continue;
          for (const entry of parent.entries) {
            if (!liveDeclarer(parent, entry)) continue;
            if (!entry.children?.some((decl) => decl.name === child)) continue;
            if (
              entry.owner.id === found.declaration.owner.id &&
              entry.owner.generation === found.declaration.owner.generation
            )
              return name;
          }
        }
        return null;
      };
      const node = (name: string, seen: Set<string>): SlotSnapshotNode => {
        const slot = slots.get(name)!;
        const elected = slot.declaration.kind === "chain" ? ordered(slot)[0] : undefined;
        const children: SlotSnapshotNode[] = [];
        seen.add(name);
        for (const candidate of slots.keys()) {
          if (candidate === name || seen.has(candidate)) continue;
          if (parentOf(candidate) === name) children.push(node(candidate, seen));
        }
        children.sort((a, b) => a.name.localeCompare(b.name));
        return {
          name: slot.declaration.name,
          kind: slot.declaration.kind,
          owner: slot.declaration.owner.id,
          entries: slot.entries.map((entry) => ({
            id: entry.id,
            owner: entry.owner.id,
            priority: entry.priority,
            order: entry.order,
            elected: elected === entry,
          })),
          elected: elected?.id ?? null,
          children,
        };
      };
      const roots = [...slots.keys()].filter((name) => parentOf(name) === null);
      roots.sort();
      return roots.map((name) => node(name, new Set()));
    },
    _slot: createSlot(native),
    _native: native,
  };
  return api;
}

/**
 * The actual construction entry point — replaces regions.tsx's
 * `createRegions`. Wraps `createSlotRegistry` with the chrome-specific
 * `Slots` surface (dock geometry, divider, overlay stack) that App.tsx and
 * every plugin consumer are written against. This is the function
 * plugin/services.ts, app.tsx, testing.ts, and test-environment.ts import.
 */
export function createSlots(renderer: CliRenderer, contributions: PluginContributions): Slots {
  type Chrome = ChromeOccupant;
  const table = contributions.table<Chrome>();
  const registry = createSlotRegistry(renderer, contributions, {
    onPluginError(event) {
      Effect.runFork(
        Effect.logError(
          `panel ${event.pluginId} failed during ${event.phase}` +
            (event.slot ? ` in ${event.slot}` : "") +
            `: ${event.error.message}`,
        ),
      );
    },
  });
  const Slot = (registry as SlotRegistry & { readonly _slot: unknown })._slot;
  const dividers = new Map<string, Divider>();
  const placements = new Map<string, string>();
  const priorities = new Map<string, number>();
  const entryKey = (owner: PluginInstance, name: string) =>
    `${owner.id}#${owner.generation}:${name}`;
  const registered = () =>
    table.all().map((entry) => {
      const key = entryKey(entry.owner, entry.name);
      return { value: entry.value, slot: placements.get(key), priority: priorities.get(key) };
    });
  const showing = (occupant: Chrome) => occupant.visible?.() ?? true;
  const dock = (side: DockSide, anchor: Anchor) =>
    registered()
      .filter((entry) => entry.slot === `${side}.${anchor}`)
      .map((entry) => entry.value as DockOccupant);
  const visibleDock = (side: DockSide, anchor: Anchor) => dock(side, anchor).filter(showing);
  const registerChrome = (
    owner: PluginInstance,
    slot: string,
    occupant: Chrome,
    priority: number,
  ) => {
    const remove = table.add(owner, occupant.id, occupant);
    const key = entryKey(owner, occupant.id);
    placements.set(key, slot);
    priorities.set(key, priority);
    const dispose = registry.register(owner, {
      slot,
      priority,
      content: (_ctx: NativeSlotContext, props: NativeSlotProps) =>
        createComponent(Show, {
          keyed: true,
          get when() {
            return table.get(occupant.id) === occupant && showing(occupant);
          },
          get children() {
            const component: (props: NativeSlotProps) => JSX.Element = occupant.component as never;
            return createComponent(component, props);
          },
        }),
    });
    return () => {
      dispose();
      remove();
      placements.delete(key);
      priorities.delete(key);
    };
  };
  const thickness = (side: DockSide, anchor: Anchor) =>
    visibleDock(side, anchor).reduce(
      (max, occupant) => Math.max(max, Math.max(occupant.size(), occupant.minSize ?? 0)),
      0,
    );
  const divider = (side: DockSide, anchor: Anchor) => {
    const visible = visibleDock(side, anchor);
    if (thickness(side, anchor) <= 0 || !visible.some((occupant) => occupant.resizable))
      return null;
    const key = `${side}.${anchor}`;
    const current = dividers.get(key);
    if (current) return current;
    const made = new Divider(renderer, {
      id: `region-divider-${key}`,
      axis: side === "left" || side === "right" ? "row" : "column",
      onDrag: (delta) => {
        const grow = side === "left" || side === "top" ? delta : -delta;
        for (const occupant of visibleDock(side, anchor))
          if (occupant.resizable) occupant.onResize?.(grow);
      },
    });
    made.hitboxOnly = true;
    made.position = "absolute";
    made.setPosition(INNER_EDGE[side]);
    made.zIndex = 1;
    dividers.set(key, made);
    return made;
  };
  const host: PluginInstance = { id: "amux.host", generation: 0 };
  registry.register(host, {
    slot: "root",
    // `ordered` prefers smaller values, so the built-in frame must sort last:
    // any frame candidate with an ordinary priority is allowed to replace it.
    priority: Number.MAX_SAFE_INTEGER,
    selector: () => true,
    children: [
      ...(["left", "right", "top", "bottom"] as DockSide[]).flatMap((side) =>
        ["app", "center"].map((anchor) => ({ name: `${side}.${anchor}`, kind: "list" as const })),
      ),
      { name: "overlay", kind: "list" },
      { name: "float", kind: "list" },
    ],
    content: (_ctx: NativeSlotContext, props: NativeSlotProps) =>
      createComponent(App, props as RootSlotProps),
  });
  const api: Slots & { readonly _registry: SlotRegistry } = {
    _registry: registry,
    Slot,
    declared: (side, anchor) => dock(side, anchor).length > 0,
    thickness,
    divider,
    topOverlay: () => {
      return (
        registered()
          .filter((entry) => entry.slot === "overlay")
          .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
          .map((entry) => entry.value)
          .filter((occupant): occupant is OverlayOccupant => !("side" in occupant))
          .filter(showing)
          .at(-1) ?? null
      );
    },
    register(owner, slot, occupant, priority = 0) {
      return registerChrome(owner, slot, occupant, priority);
    },
  };
  return api;
}

const INNER_EDGE = {
  left: { top: 0, right: 0, bottom: 0 },
  right: { top: 0, left: 0, bottom: 0 },
  top: { left: 0, right: 0, bottom: 0 },
  bottom: { left: 0, right: 0, top: 0 },
} as const satisfies Record<
  DockSide,
  { top?: number; right?: number; bottom?: number; left?: number }
>;
