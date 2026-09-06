/**
 * Where a `LayoutContainer`'s `kind` (layout.ts) becomes two independent
 * facts: how to validate its opaque `arrangement`, and how to draw it.
 *
 * Kept as its own small module rather than folded into an existing registry
 * because neither existing one fits: `ui/slots.ts`'s registry unconditionally
 * bridges every registered entry through Solid/opentui JSX (`sync()`), which
 * a plain BoxRenderable-building function is not; `TilingAlgorithmsTag`
 * (plugin/services.ts) elects one `TilingAlgorithm` per window, but a kind
 * and an algorithm are many-to-many — niri's own tree mixes `kind: "scroll"`
 * at the root with plain `LayoutSplit` nodes for each column, and any future
 * algorithm can reuse "split" the same way. See
 * docs/adr/0004-arrangement-kind-is-an-open-registry.md.
 *
 * The two registrations run in different processes and are made
 * independently: a schema from a plugin's `"./daemon"` entrypoint (decoding
 * session.json and wire snapshots is daemon-side), a renderer from its `"."`
 * (UI) entrypoint (opentui materialization is client-side). Neither knows
 * the other exists; a kind that registers only one of them still decodes (as
 * unvalidated arrangement) or still renders (as no-op passthrough,
 * respectively) — see the fallbacks below.
 */
import type { Renderable, RenderContext } from "@opentui/core";
import { Effect, Schema as S, Scope } from "effect";
import type { LayoutContainer } from "./layout.ts";

const schemas = new Map<string, S.Schema<unknown>>();
const renderers = new Map<string, LayoutKindRenderer>();

export interface LayoutKindRenderer {
  /** `children` are already materialized — this only arranges them. */
  render(ctx: RenderContext, node: LayoutContainer, children: readonly Renderable[]): Renderable;
}

/** Register `kind`'s arrangement schema — decoded against raw `unknown` input
 *  via `S.decodeUnknownEffect`, so any `Schema` works regardless of its own
 *  encoded type. Dies naming the earlier owner if `kind` already has one —
 *  "declaring is claiming," the same rule `ui/slots.ts` enforces for chrome
 *  slots. Disposed when the registering plugin's scope closes. */
export function registerLayoutKindSchema<A>(
  kind: string,
  schema: S.Schema<A>,
): Effect.Effect<void, never, Scope.Scope> {
  if (schemas.has(kind)) {
    return Effect.die(
      new Error(`layout kind '${kind}' already has a registered arrangement schema`),
    );
  }
  schemas.set(kind, schema as S.Schema<unknown>);
  return Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (schemas.get(kind) === schema) schemas.delete(kind);
    }),
  );
}

/** `kind`'s registered arrangement schema, or undefined if no plugin
 *  providing it is currently loaded — a decode-time fact, not an error: see
 *  the "missing kind" consequence in ADR 0004. */
export function layoutKindSchema(kind: string): S.Schema<unknown> | undefined {
  return schemas.get(kind);
}

/** Register `kind`'s renderer. Same collision/disposal rules as
 *  `registerLayoutKindSchema`. */
export function registerLayoutKindRenderer(
  kind: string,
  renderer: LayoutKindRenderer,
): Effect.Effect<void, never, Scope.Scope> {
  if (renderers.has(kind)) {
    return Effect.die(new Error(`layout kind '${kind}' already has a registered renderer`));
  }
  renderers.set(kind, renderer);
  return Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (renderers.get(kind) === renderer) renderers.delete(kind);
    }),
  );
}

/** `kind`'s registered renderer, or undefined if no plugin providing it is
 *  currently loaded. Synchronous and side-effect-free: `Window#mount()`
 *  calls it inline while building renderables, not through Effect. */
export function layoutKindRenderer(kind: string): LayoutKindRenderer | undefined {
  return renderers.get(kind);
}
