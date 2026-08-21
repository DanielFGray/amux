import { expect, test } from "bun:test";
import { Terminal } from "./ghostty.ts";

const esc = "\x1b";

function kitty(command: string, payload = ""): Uint8Array {
  return new TextEncoder().encode(`${esc}_G${command};${payload}${esc}\\`);
}

test("Terminal exposes Kitty RGBA placements with owned pixels", () => {
  const terminal = new Terminal(10, 4);
  try {
    terminal.write(kitty("a=t,f=32,s=1,v=1,i=7", Buffer.from([255, 0, 0, 255]).toString("base64")));
    terminal.write(kitty("a=p,i=7,c=1,r=1"));

    const [placement] = terminal.kittyGraphics();
    expect(placement).toMatchObject({
      imageId: 7,
      width: 1,
      height: 1,
      format: "rgba",
      columns: 1,
      rows: 1,
      column: 0,
      row: 0,
    });
    expect([...placement!.pixels]).toEqual([255, 0, 0, 255]);
  } finally {
    terminal.free();
  }
});
