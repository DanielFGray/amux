/**
 * The options, as values.
 *
 * One entry per setting, and that single declaration is what every consumer
 * derives from: the type of the resolved value, the default, the validation a
 * hand-edited file goes through, the row the settings window draws, what ←/→
 * does to it, and whether it is written to disk at all. The same pressure that
 * produced commands.ts produced this — an option used to be declared in seven
 * places (a field on an interface, a default, a bounds record, a decoder arm, a
 * runtime mirror, a UI row, and an arm of an if/else chain that mutated it),
 * three of which had already drifted apart.
 *
 * The name is dotted and it is the option's identity: it is what `config.set`
 * takes, what the file records, and what the settings window prints. The prefix
 * doubles as the section, the way commands.ts lets a command's namespace double
 * as its help group, so a section is not a second thing to declare.
 */

/** Bounded because every numeric option has an answer to "how far can it go?",
 *  and the one place that answer belongs is here. */
interface NumberSpec {
  readonly kind: "number";
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly desc: string;
}

interface BooleanSpec {
  readonly kind: "boolean";
  readonly default: boolean;
  readonly desc: string;
}

interface StringSpec {
  readonly kind: "string";
  readonly default: string;
  readonly desc: string;
  readonly editable?: boolean;
}

export type OptionSpec = NumberSpec | BooleanSpec | StringSpec;
export type OptionValue = number | boolean | string;

export const OPTIONS = {
  "sidebar.open": { kind: "boolean", default: true, desc: "show the sidebar" },
  "sidebar.width": { kind: "number", default: 30, min: 16, max: 60, desc: "columns" },
  "sidebar.agentsOnly": {
    kind: "boolean",
    default: false,
    desc: "list only panes running a recognised agent CLI",
  },

  "appearance.gap": {
    kind: "boolean",
    default: false,
    desc: "separate pane borders",
  },
  "appearance.outerBorder": {
    kind: "boolean",
    default: true,
    desc: "show the outside border when gap is enabled",
  },
  "appearance.padding": {
    kind: "boolean",
    default: false,
    desc: "pad the main frame by one cell",
  },
  "appearance.whichKeyHints": {
    kind: "boolean",
    default: true,
    desc: "show the which-key panel after a prefix",
  },
  "appearance.whichKeyDelay": {
    kind: "number",
    default: 0,
    min: 0,
    max: 5,
    desc: "seconds before the which-key panel appears",
  },

  "behaviour.scrollRows": {
    kind: "number",
    default: 3,
    min: 1,
    max: 20,
    desc: "rows per wheel notch",
  },
  "behaviour.shell": {
    kind: "string",
    default: "",
    desc: "shell for new agents · empty uses $SHELL",
  },
  "agent.model": {
    kind: "string",
    default: "openai/gpt-4o-mini",
    desc: "provider/model for native agents",
    editable: true,
  },
  "agent.showThinking": {
    kind: "boolean",
    default: false,
    desc: "show agent thinking traces",
  },
  "notifications.blocked": {
    kind: "boolean",
    default: true,
    desc: "ring the terminal when an agent becomes blocked",
  },
} as const satisfies Record<string, OptionSpec>;

export type OptionName = keyof typeof OPTIONS;

export function parseModelReference(
  value: string,
): { readonly providerID: string; readonly modelID: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}

type ValueOf<S> = S extends NumberSpec ? number : S extends BooleanSpec ? boolean : string;

/** Every option resolved to a value — what the app reads. */
export type Options = { readonly [K in OptionName]: ValueOf<(typeof OPTIONS)[K]> };

/**
 * What is written to disk: only the options a user has actually changed.
 *
 * Deltas rather than a full table, for the same reason keys.bindings records
 * only rebound commands — a saved file that pins every default freezes them at
 * whatever they were the first time the user pressed `s`, and a later release
 * changing a default reaches nobody. Storing deltas also means the entries an
 * unrecognised name owns survive: they are kept verbatim and written back, so
 * turning a plugin off does not flatten its settings out of the file.
 */
export type OptionDeltas = Readonly<Record<string, unknown>>;

export function optionSpec(name: string): OptionSpec | undefined {
  return Object.hasOwn(OPTIONS, name) ? OPTIONS[name as OptionName] : undefined;
}

export const optionNames = Object.keys(OPTIONS) as OptionName[];

/** The distinct name prefixes, in declaration order — the settings window's tabs. */
export const optionSections = [...new Set(optionNames.map(sectionOf))];

export function optionsIn(section: string): OptionName[] {
  return optionNames.filter((name) => sectionOf(name) === section);
}

/** The part of a dotted name that identifies it within its section. */
export function leafOf(name: string): string {
  return name.slice(name.indexOf(".") + 1);
}

function sectionOf(name: string): string {
  return name.slice(0, name.indexOf("."));
}

/**
 * Resolve stored deltas against the table.
 *
 * Total: an entry that is missing, of the wrong type, or out of bounds falls
 * back to the default, so a hand-edited file cannot put a value into the app
 * that the app would not have accepted from its own UI.
 */
export function resolveOptions(stored: OptionDeltas): Options {
  const resolved: Record<string, OptionValue> = {};
  for (const name of optionNames) {
    const spec = OPTIONS[name];
    resolved[name] = coerceOption(spec, stored[name]) ?? spec.default;
  }
  return resolved as Options;
}

/** The value this option would take from `raw`, or undefined if it refuses it. */
export function coerceOption(spec: OptionSpec, raw: unknown): OptionValue | undefined {
  switch (spec.kind) {
    case "number":
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      return clamp(spec, Math.floor(raw));
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "string":
      return typeof raw === "string" ? raw : undefined;
  }
}

/**
 * Store a value, dropping it again when it equals the default.
 *
 * The delta rule is an invariant of the store rather than a filter applied on
 * the way to disk, which is what makes "has the user set this?" answerable at
 * any moment — `name in deltas` — instead of only while saving.
 */
export function writeOption(
  stored: OptionDeltas,
  name: OptionName,
  value: OptionValue,
): OptionDeltas {
  const next = { ...stored };
  if (value === OPTIONS[name].default) delete next[name];
  else next[name] = value;
  return next;
}

export function clearOption(stored: OptionDeltas, name: OptionName): OptionDeltas {
  const next = { ...stored };
  delete next[name];
  return next;
}

/**
 * The value a relative edit lands on: ←/→ in the settings window, and dragging
 * the sidebar's divider.
 *
 * A boolean flips, because a settings row has to answer ←/→ without its caller
 * branching on the option's kind — knowing that is this table's job. A string
 * has no relative form and stays put.
 */
export function adjustedValue(spec: OptionSpec, current: OptionValue, by: number): OptionValue {
  switch (spec.kind) {
    case "number":
      return clamp(spec, (current as number) + by);
    case "boolean":
      return !(current as boolean);
    case "string":
      return current;
  }
}

/** How the value reads on screen. */
export function formatOption(spec: OptionSpec, value: OptionValue): string {
  if (spec.kind === "boolean") return value ? "yes" : "no";
  if (spec.kind === "string") return (value as string) || "unset";
  return String(value);
}

/** What the row says you can do to it, which follows from the kind. */
export function editHint(spec: OptionSpec): string {
  switch (spec.kind) {
    case "number":
      return "←/→ adjusts";
    case "boolean":
      return "←/→ toggles";
    case "string":
      return spec.editable ? "enter edits" : "read-only";
  }
}

function clamp(spec: NumberSpec, value: number): number {
  return Math.max(spec.min, Math.min(spec.max, value));
}

/**
 * Live option values that imperative code reads at the point of use.
 *
 * Kept in step by applyOptions(). Pane borders and wheel scrolling are read
 * from renderables and event handlers that have no path back to the app's
 * reactive graph; ts-6b5314 is where the global goes away.
 */
export const runtime: { [K in OptionName]: ValueOf<(typeof OPTIONS)[K]> } = resolveOptions({});

export function applyOptions(options: Options): void {
  Object.assign(runtime, options);
}
