import { expect, test } from "bun:test";
import { captureScrollback } from "./capture.ts";
import { Terminal } from "./ghostty.ts";

test("WRITE_PTY delivers a cursor-position query response", () => {
  const responses: Uint8Array[] = [];
  const term = new Terminal(40, 10);
  try {
    term.setWritePty((bytes) => responses.push(bytes));
    term.write(new TextEncoder().encode("\x1b[6n"));
    expect(responses).toHaveLength(1);
    expect(new TextDecoder().decode(responses[0]!)).toMatch(
      new RegExp(`^${String.fromCharCode(0x1b)}\\[\\d+;\\d+R$`),
    );
  } finally {
    term.free();
  }
});

test("clearing WRITE_PTY stops further query responses", () => {
  const responses: Uint8Array[] = [];
  const term = new Terminal(40, 10);
  try {
    term.setWritePty((bytes) => responses.push(bytes));
    term.setWritePty(null);
    term.write(new TextEncoder().encode("\x1b[6n"));
    expect(responses).toHaveLength(0);
  } finally {
    term.free();
  }
});

test("bounded scrollback retains lines that have left the viewport", () => {
  const term = new Terminal(40, 4);
  try {
    term.write(new TextEncoder().encode("EARLY_OUTPUT\r\n" + "later\r\n".repeat(2000)));
    expect(captureScrollback(term)).toContain("EARLY_OUTPUT");
  } finally {
    term.free();
  }
});

test("scrollback 0 drops lines that leave the viewport", () => {
  const term = new Terminal(40, 4, 0);
  try {
    term.write(new TextEncoder().encode("EARLY_OUTPUT\r\n" + "later\r\n".repeat(2000)));
    expect(captureScrollback(term)).not.toContain("EARLY_OUTPUT");
  } finally {
    term.free();
  }
});
