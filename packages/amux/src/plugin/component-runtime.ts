/**
 * The small, renderer-free runtime behind dynamically composable components.
 *
 * A component owns every inverse its async effect iterator yields. Providers
 * are identified by fiber id, rather than service value, so replacing an equal
 * value is still observable by its dependents.
 */

export type Inverse = () => void | Promise<void>;

export interface ComponentContext {
  /** Read a dependency from the view committed for this activation. */
  readonly get: <A>(service: Service<A>) => A;
  /** Publish a declared service while this component is active. */
  readonly provide: <A>(service: Service<A>, value: A) => void;
}

export interface Service<A> {
  readonly key: string;
  readonly _service?: A;
}

export const service = <A>(key: string): Service<A> => ({ key });

export interface Component {
  readonly id: string;
  readonly requires?: readonly Service<unknown>[];
  readonly provides?: readonly Service<unknown>[];
  readonly run: (context: ComponentContext) => AsyncGenerator<Inverse, void, void>;
}

export type FiberState = "inactive" | "loading" | "active" | "unloading";

export interface FiberStatus {
  readonly id: string;
  readonly state: FiberState;
  readonly waitingFor: readonly string[];
}

interface Fiber {
  readonly component: Component;
  readonly inverses: Inverse[];
  readonly values: Map<string, unknown>;
  committed: Map<string, Fiber> | undefined;
  target: Map<string, Fiber> | undefined;
  state: FiberState;
  transition: Promise<void> | undefined;
  retired: boolean;
}

/**
 * A component/fiber runtime with no plugin-host policy baked in. `add` and
 * `remove` are orchestration; all dependent reloads follow from service target
 * changes. Transitions are inertial: once an async step has started it lands,
 * then the fiber chains into the state its newest target requires.
 */
export class ComponentRuntime {
  readonly #fibers = new Map<string, Fiber>();

  add(component: Component): void {
    if (this.#fibers.has(component.id)) {
      throw new Error(`component '${component.id}' already exists`);
    }
    this.#assertUniqueProviders(component);
    this.#fibers.set(component.id, {
      component,
      inverses: [],
      values: new Map(),
      committed: undefined,
      target: undefined,
      state: "inactive",
      transition: undefined,
      retired: false,
    });
    this.#refreshAll();
  }

  remove(id: string): void {
    const fiber = this.#fibers.get(id);
    if (!fiber) return;
    fiber.retired = true;
    this.#refresh(fiber);
  }

  status(): readonly FiberStatus[] {
    return [...this.#fibers.values()].map((fiber) => ({
      id: fiber.component.id,
      state: fiber.state,
      waitingFor: this.#missing(fiber).map((service) => service.key),
    }));
  }

  /** Wait until all lifecycle work, including chained reloads, is quiescent. */
  async settle(): Promise<void> {
    for (;;) {
      const transitions = [...this.#fibers.values()]
        .map((fiber) => fiber.transition)
        .filter((transition): transition is Promise<void> => transition !== undefined);
      if (transitions.length === 0) return;
      await Promise.all(transitions);
    }
  }

  #assertUniqueProviders(component: Component): void {
    for (const provided of component.provides ?? []) {
      for (const fiber of this.#fibers.values()) {
        if ((fiber.component.provides ?? []).some((service) => service.key === provided.key)) {
          throw new Error(`service '${provided.key}' already belongs to '${fiber.component.id}'`);
        }
      }
    }
  }

  #providerFor(service: Service<unknown>): Fiber | undefined {
    return [...this.#fibers.values()].find(
      (fiber) =>
        fiber.state === "active" &&
        !fiber.retired &&
        (fiber.component.provides ?? []).some((provided) => provided.key === service.key),
    );
  }

  #targetFor(fiber: Fiber): Map<string, Fiber> | undefined {
    if (fiber.retired) return undefined;
    const target = new Map<string, Fiber>();
    for (const required of fiber.component.requires ?? []) {
      const provider = this.#providerFor(required);
      if (!provider) return undefined;
      target.set(required.key, provider);
    }
    return target;
  }

  #sameTarget(left: Map<string, Fiber> | undefined, right: Map<string, Fiber> | undefined) {
    if (left === right) return true;
    if (!left || !right || left.size !== right.size) return false;
    return [...left].every(([key, provider]) => right.get(key) === provider);
  }

  #missing(fiber: Fiber): readonly Service<unknown>[] {
    if (fiber.retired) return [];
    return (fiber.component.requires ?? []).filter((service) => !this.#providerFor(service));
  }

  #refreshAll(): void {
    for (const fiber of this.#fibers.values()) this.#refresh(fiber);
  }

  #refresh(fiber: Fiber): void {
    const target = this.#targetFor(fiber);
    if (this.#sameTarget(target, fiber.target)) {
      if (fiber.retired && fiber.state === "inactive") this.#fibers.delete(fiber.component.id);
      return;
    }
    fiber.target = target;
    if (fiber.transition) return;
    this.#start(fiber, target ? "load" : "unload");
  }

  #start(fiber: Fiber, direction: "load" | "unload"): void {
    fiber.state = direction === "load" ? "loading" : "unloading";
    // Becoming unavailable precedes inverses. This makes dependent teardown
    // start while this fiber's committed services remain readable.
    if (direction === "unload") this.#refreshAll();
    const transition = this.#run(fiber, direction);
    fiber.transition = transition.finally(() => {
      fiber.transition = undefined;
    });
  }

  async #run(fiber: Fiber, direction: "load" | "unload"): Promise<void> {
    for (;;) {
      if (direction === "load") {
        await this.#load(fiber);
        if (fiber.state === "active" && this.#sameTarget(fiber.target, fiber.committed)) return;
        direction = "unload";
        fiber.state = "unloading";
        this.#refreshAll();
        continue;
      }
      await this.#unload(fiber);
      if (fiber.retired || !fiber.target) return;
      direction = "load";
      fiber.state = "loading";
    }
  }

  async #load(fiber: Fiber): Promise<void> {
    const target = fiber.target;
    if (!target) return;
    fiber.committed = target;
    const iterator = fiber.component.run(this.#context(fiber));
    while (this.#sameTarget(fiber.target, target)) {
      const step = await iterator.next();
      if (step.value) fiber.inverses.push(step.value);
      if (step.done) break;
    }
    if (this.#sameTarget(fiber.target, target)) {
      fiber.state = "active";
      this.#refreshAll();
    }
  }

  async #unload(fiber: Fiber): Promise<void> {
    // Direct and transitive dependents have already been made unavailable by
    // refresh. Wait for their inertial teardown before releasing this fiber.
    await Promise.all(this.#dependentsOf(fiber).map((dependent) => this.#awaitInactive(dependent)));
    while (fiber.inverses.length > 0) await fiber.inverses.pop()!();
    fiber.values.clear();
    fiber.committed = undefined;
    fiber.state = "inactive";
    if (fiber.retired) this.#fibers.delete(fiber.component.id);
    this.#refreshAll();
  }

  #dependentsOf(provider: Fiber): readonly Fiber[] {
    return [...this.#fibers.values()].filter((fiber) =>
      [...(fiber.committed?.values() ?? [])].some((target) => target === provider),
    );
  }

  async #awaitInactive(fiber: Fiber): Promise<void> {
    while (fiber.state !== "inactive") {
      const transition = fiber.transition;
      if (!transition) return;
      await transition;
    }
  }

  #context(fiber: Fiber): ComponentContext {
    return {
      get: <A>(requested: Service<A>): A => {
        const provider = fiber.committed?.get(requested.key);
        if (!provider) throw new Error(`service '${requested.key}' is not committed`);
        return provider.values.get(requested.key) as A;
      },
      provide: <A>(provided: Service<A>, value: A): void => {
        if (!(fiber.component.provides ?? []).some((service) => service.key === provided.key)) {
          throw new Error(`component '${fiber.component.id}' did not declare '${provided.key}'`);
        }
        fiber.values.set(provided.key, value);
      },
    };
  }
}
