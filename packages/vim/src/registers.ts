/**
 * Vim register bank — unnamed, named a–z / A–Z append, numbered 0–9,
 * black-hole `_`, and special `.` `:` `/` `+` `*`.
 *
 * `+` / `*` also emit an `EditorRequest.clipboard` so the pane shell can
 * OSC-52 the host (`"+` → clipboard, `"*` → primary). Cite: amux pane
 * `copyText` / OSC-52 clipboard write.
 */
import type { EditorState, Register } from "./schema.ts";

export const emptyRegister = (): Register => ({ text: [], linewise: false });

/** Sentinel: `"` was pressed; waiting for the register name. */
export const REGISTER_PICKING = "?";

export const normalizeRegName = (name: string): string => {
  if (name === "" || name === '"') return '"';
  return name;
};

/** Names accepted after `"` or insert Ctrl-r. */
export const isRegisterName = (name: string): boolean =>
  name.length === 1 && /[a-zA-Z0-9"+*_.:/]/.test(name);

export const readRegister = (state: EditorState, name: string): Register => {
  const n = normalizeRegName(name);
  if (n === "_") return emptyRegister();
  if (n === '"') return state.register;
  return state.registers[n] ?? emptyRegister();
};

const mergeAppend = (prev: Register, next: Register): Register => {
  if (prev.text.length === 0) return next;
  if (next.text.length === 0) return prev;
  if (prev.linewise || next.linewise) {
    return { text: [...prev.text, ...next.text], linewise: true };
  }
  const out = [...prev.text];
  out[out.length - 1] = (out[out.length - 1] ?? "") + (next.text[0] ?? "");
  out.push(...next.text.slice(1));
  return { text: out, linewise: false };
};

export type RegisterWriteKind = "yank" | "delete" | "set";

/**
 * Write `value` into the target register. Yanks update `"0` + unnamed;
 * deletes rotate `"1`–`"9` + unnamed. Named ops also refresh unnamed
 * (vim). `_` discards. `A`–`Z` append into the lowercase slot.
 */
export const writeRegister = (
  state: EditorState,
  name: string,
  value: Register,
  kind: RegisterWriteKind,
): EditorState => {
  const raw = name === "" ? state.selectedRegister || '"' : name;
  const n = normalizeRegName(raw);
  if (n === "_") {
    return { ...state, selectedRegister: "" };
  }

  const append = /^[A-Z]$/.test(n);
  const slot = append ? n.toLowerCase() : n === '"' ? '"' : n;

  let stored = value;
  if (append) {
    stored = mergeAppend(state.registers[slot] ?? emptyRegister(), value);
  }

  const registers = { ...state.registers };
  let unnamed = state.register;

  if (slot === '"') {
    unnamed = stored;
  } else {
    registers[slot] = stored;
    if (kind !== "set") unnamed = stored;
  }

  if (kind === "yank") {
    registers["0"] = stored;
    unnamed = stored;
  }

  if (kind === "delete") {
    for (let i = 9; i >= 2; i--) {
      const prev = registers[String(i - 1)];
      if (prev !== undefined) registers[String(i)] = prev;
      else delete registers[String(i)];
    }
    registers["1"] = stored;
    unnamed = stored;
  }

  const next: EditorState = {
    ...state,
    register: unnamed,
    registers,
    selectedRegister: "",
  };

  // `"+` / `"*` → host clipboard via OSC 52 (pane shell fulfills the request).
  if ((slot === "+" || slot === "*") && (kind === "yank" || kind === "delete")) {
    const text =
      stored.text.length === 0
        ? ""
        : stored.linewise
          ? `${stored.text.join("\n")}\n`
          : stored.text.join("\n");
    if (text.length > 0) {
      return {
        ...next,
        request: {
          _tag: "clipboard",
          text,
          target: slot === "*" ? "primary" : "clipboard",
        },
      };
    }
  }

  return next;
};

/** Active register for the next yank/delete/put (`""` → unnamed). */
export const activeReg = (state: EditorState): string =>
  state.selectedRegister === "" ? '"' : state.selectedRegister;
