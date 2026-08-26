import { createSignal } from "solid-js";

/**
 * One run of a plugin.
 *
 * Two instances share an id during a reload: the one the app is looking at and
 * the one being tried. The generation tells them apart. It is the host's to hand
 * out — a plugin never sees its own generation, because a plugin that could name
 * a generation could write into one that is not its own.
 */
export interface PluginInstance {
  readonly id: string;
  readonly generation: number;
}

export interface Contribution<T> {
  readonly owner: PluginInstance;
  readonly name: string;
  readonly value: T;
}

export interface ContributionTable<T> {
  /** Claim a name. Returns the disposer a scope finalizer wants. */
  readonly add: (owner: PluginInstance, name: string, value: T) => () => void;
  /** What a committed instance put under this name, if anything. */
  readonly get: (name: string) => T | undefined;
  /** Everything the committed instances put in, in the order it arrived. */
  readonly all: () => readonly Contribution<T>[];
}

/**
 * Every name a plugin can claim, in tables that agree on whose claims count.
 *
 * A plugin writes into a table as soon as it runs, but nothing reads what it
 * wrote until the host commits that instance. That is what lets a reload stand
 * the new version up beside the running one: the new generation registers under
 * the names the old generation still holds, and exactly one of them is visible.
 * A version that dies before it commits is closed having been seen by nobody,
 * so the running version is never touched and its dependents never unwind.
 *
 * Tables are signal-backed, so a commit repaints the app the same way any other
 * state change does.
 */
export interface PluginContributions {
  /** A fresh table. Made once per registry at wiring time, not per plugin. */
  readonly table: <T>() => ContributionTable<T>;
  /**
   * Make this instance the visible one for its id.
   *
   * Returns the names that stopped it, empty when it committed. A name held by
   * a *different* plugin is a real conflict and cannot be resolved by picking a
   * winner, so the caller keeps whatever was running and reports these.
   */
  readonly commit: (owner: PluginInstance) => readonly string[];
  /** Drop this instance's claim to being visible, if it still holds it. */
  readonly retire: (owner: PluginInstance) => void;
  readonly isCommitted: (owner: PluginInstance) => boolean;
}

export function createPluginContributions(): PluginContributions {
  const [committed, setCommitted] = createSignal<ReadonlyMap<string, number>>(new Map());
  const tables: { readonly conflicts: (owner: PluginInstance) => readonly string[] }[] = [];

  const isCommitted = (owner: PluginInstance) => committed().get(owner.id) === owner.generation;

  function table<T>(): ContributionTable<T> {
    const [entries, setEntries] = createSignal<readonly Contribution<T>[]>([]);
    const visible = () => entries().filter((entry) => isCommitted(entry.owner));

    tables.push({
      conflicts(owner) {
        const claimed = new Set(
          entries()
            .filter((entry) => sameInstance(entry.owner, owner))
            .map((entry) => entry.name),
        );
        return visible()
          .filter((entry) => entry.owner.id !== owner.id && claimed.has(entry.name))
          .map((entry) => entry.name);
      },
    });

    return {
      add(owner, name, value) {
        if (entries().some((entry) => sameInstance(entry.owner, owner) && entry.name === name))
          throw new Error(`plugin '${owner.id}' registered '${name}' twice`);
        // A name another plugin is already showing is refused on the spot, the
        // way it always was. A name held by an earlier generation of this same
        // plugin is not a conflict — that is what a reload looks like — and one
        // taken while this instance was invisible is caught again at the commit.
        const taken = visible().find((entry) => entry.name === name && entry.owner.id !== owner.id);
        if (taken) throw new Error(`'${name}' is already registered by '${taken.owner.id}'`);
        const entry: Contribution<T> = { owner, name, value };
        setEntries((current) => [...current, entry]);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          setEntries((current) => current.filter((registered) => registered !== entry));
        };
      },
      get: (name) => visible().find((entry) => entry.name === name)?.value,
      all: visible,
    };
  }

  return {
    table,
    isCommitted,
    commit(owner) {
      const conflicts = tables.flatMap((registered) => registered.conflicts(owner));
      if (conflicts.length > 0) return conflicts;
      setCommitted((current) => new Map(current).set(owner.id, owner.generation));
      return [];
    },
    retire(owner) {
      setCommitted((current) => {
        if (current.get(owner.id) !== owner.generation) return current;
        const next = new Map(current);
        next.delete(owner.id);
        return next;
      });
    },
  };
}

const sameInstance = (a: PluginInstance, b: PluginInstance) =>
  a.id === b.id && a.generation === b.generation;
