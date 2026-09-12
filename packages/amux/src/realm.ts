import { Context, Option } from "effect";

/**
 * Which realm a command is running in, and what that realm binds.
 *
 * This is the paper's coeffect isolation (Definition 25) at dispatch grain.
 * The plugin service table resolves a key `k` through a realm table `rho`:
 * `get(k) = sigma(rho(k))`. A key nobody isolated keeps `rho(k) = k` and
 * resolves to the one shared binding; a key bound per realm resolves to the
 * binding for *this* realm. Isolation has derived realization (Definition 23),
 * so the realm is a fresh context that lives for one dispatch and is recovered
 * by discarding it — which is why it carries no inverse while `provide` does.
 *
 * The motivating case is a plugin that serves many panes. Before this, the
 * editor plugin resolved "which pane" by hand at every call site:
 *
 *     const focusedEditor = () => controllers().find((c) => c.active()) ?? null;
 *     // ...then focusedEditor()?.requestHover(), ~30 times over
 *
 * That is `sigma(rho(k))` written out by hand with `rho` = the focused pane.
 * With a realm the pane binds its own controller and a command reads it:
 *
 *     const realm = yield* Realm;
 *     const controller = realm.get(EditorControllerTag);
 *
 * `get` returns `Option` rather than throwing, because "no pane is focused"
 * and "this realm binds no such service" are ordinary states a command has to
 * answer for, not defects.
 */
export interface RealmValue {
  /** The realm's identifier, or undefined when the dispatch has no realm. */
  readonly id: string | undefined;
  /** This realm's binding for `tag`, if it has one. */
  readonly get: <Id, S>(tag: Context.Service<Id, S>) => Option.Option<S>;
}

/**
 * The realm a command is dispatched in. Declared in a command's requirement
 * channel the same way {@link KeyInvocation} is: a command that needs none
 * stays `Effect<any, CommandError>` and is unaffected.
 */
export class Realm extends Context.Service<Realm, RealmValue>()("amux/Realm") {}

/**
 * What a dispatch supplies when nothing is focused, or when the app wired no
 * realm resolver at all. Binding nothing is the correct answer — a command
 * that needs a pane-scoped service reports the absence rather than reaching
 * for some other pane's instance.
 */
export const NO_REALM: RealmValue = {
  id: undefined,
  get: () => Option.none(),
};

/**
 * The realm identifier for a pane. One speller, so a pane publishing a service
 * and a command reading it cannot disagree about which realm they mean.
 */
export const paneRealm = (paneId: string): string => `pane:${paneId}`;

/** A realm reading its bindings out of one derived context. */
export const realmOf = (id: string, context: Context.Context<never>): RealmValue => ({
  id,
  get: (tag) => Context.getOption(context, tag),
});
