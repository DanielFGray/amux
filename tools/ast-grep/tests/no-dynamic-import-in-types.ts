// Should flag (param + return):
function f(x: import("a").T1): import("b").T2 {
  return null as never;
}

// Should flag:
type Alias = import("c").T;
interface I {
  p: import("d").T;
}
type Fn = (x: import("e").T) => import("f").U;
type Nested = Promise<import("g").T>;
const asserted = null as import("h").T;

// Should not flag (value-level dynamic import):
const value = import("i");
const chained = import("j").then((m) => m);

// Should not flag (value import nested under satisfies — lazy ops pattern):
const ops = {
  add: () => import("lazy").then((m) => m.add()),
} satisfies { add: () => Promise<unknown> };

// Should not flag (typeof import is a different form):
type Mod = typeof import("k");
