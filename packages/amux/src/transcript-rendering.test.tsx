/** @effect-diagnostics *:skip-file -- plain-async by design: SolidJS/opentui render tree, or a real OS boundary (PTY/socket/subprocess) this suite deliberately drives unmocked. See the seam documented in packages/amux/src/harness.ts. */
/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { CapturedFrame, CapturedLine } from "@opentui/core";
import { render } from "@opentui/solid";
import { Terminal } from "./ghostty.ts";
import { captureScrollback } from "./capture.ts";
import { cellColumnOf, rowCells, stringIndexOf } from "./copy.ts";

type TranscriptEvent =
  | { type: "message"; role: "user" | "assistant"; text: string }
  | { type: "tool"; name: string; arguments: string; result: string };

const events: readonly TranscriptEvent[] = [
  {
    type: "message",
    role: "user",
    text: "Inspect transcript rendering and keep 你好 copy, search, and capture useful in narrow panes.",
  },
  {
    type: "message",
    role: "assistant",
    text: "The transcript stays semantic so every client can reflow explanations naturally instead of replaying terminal bytes.",
  },
  {
    type: "tool",
    name: "grep",
    arguments: "pattern=CopyMode path=src",
    result: "12 matches",
  },
  {
    type: "message",
    role: "assistant",
    text: "For the TUI, retained widgets render the events and an on-demand grid snapshot supplies display rows to copy mode.",
  },
];

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

function Transcript(props: { events: readonly TranscriptEvent[] }) {
  return (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {props.events.map((event) => (
        <text wrapMode="word" style={{ width: "100%", flexShrink: 0 }}>
          {event.type === "message"
            ? `${event.role}> ${event.text}`
            : `tool> ${event.name} ${event.arguments} -> ${event.result}`}
        </text>
      ))}
    </box>
  );
}

/** Render the retained fixture into a character buffer and retain OpenTUI's
 * cell widths and style spans as input to the proposed serializer. */
async function syntheticGrid(width: number): Promise<CapturedFrame> {
  const target = await createTestRenderer({ width, height: 24 });
  disposals.push(() => target.renderer.destroy());
  await render(() => <Transcript events={events} />, target.renderer);
  await target.renderOnce();
  await target.renderOnce();

  const frame = target.captureSpans();
  let used = frame.lines.length;
  while (used > 0 && rowText(frame.lines[used - 1]!).trimEnd() === "") used--;
  return { ...frame, rows: used, lines: frame.lines.slice(0, used) };
}

function rowText(line: CapturedLine): string {
  return line.spans.map((span) => span.text).join("");
}

function capturedRows(grid: CapturedFrame, start = 0, end = grid.rows - 1): string {
  return grid.lines
    .slice(Math.max(0, start), Math.min(grid.rows, end + 1))
    .map((line) => rowText(line).trimEnd())
    .join("\n")
    .replace(/\n+$/, "");
}

function searchRows(grid: CapturedFrame, query: string): { x: number; y: number } | null {
  for (let y = 0; y < grid.rows; y++) {
    const row = rowText(grid.lines[y]!);
    const at = row.indexOf(query);
    if (at >= 0) return { x: cellColumnOf(rowCells(row), at), y };
  }
  return null;
}

function yankRows(
  grid: CapturedFrame,
  start: { x: number; y: number },
  end: { x: number; y: number },
): string {
  const rows: string[] = [];
  for (let y = start.y; y <= end.y; y++) {
    const row = rowText(grid.lines[y]!);
    const map = rowCells(row);
    const from = stringIndexOf(map, y === start.y ? start.x : 0);
    const to = stringIndexOf(map, y === end.y ? end.x + 1 : grid.cols);
    rows.push(row.slice(from, to).trimEnd());
  }
  return rows.join("\n").replace(/\n+$/, "");
}

test("80-column retained transcript is readable and serializes to a cell grid", async () => {
  const grid = await syntheticGrid(80);
  const capture = capturedRows(grid);

  expect(grid.cols).toBe(80);
  expect(
    grid.lines.every((line) => line.spans.reduce((width, span) => width + span.width, 0) === 80),
  ).toBe(true);
  expect(capture).toBe(
    [
      "user> Inspect transcript rendering and keep 你好 copy, search, and capture",
      "useful in narrow panes.",
      "assistant> The transcript stays semantic so every client can reflow",
      "explanations naturally instead of replaying terminal bytes.",
      "tool> grep pattern=CopyMode path=src -> 12 matches",
      "assistant> For the TUI, retained widgets render the events and an on-demand",
      "grid snapshot supplies display rows to copy mode.",
    ].join("\n"),
  );
});

test("the synthetic grid supports row capture, search, and yank", async () => {
  const grid = await syntheticGrid(80);
  const hit = searchRows(grid, "CopyMode");
  const wideHit = searchRows(grid, "copy");

  expect(hit).toEqual({ x: 19, y: 4 });
  expect(rowText(grid.lines[0]!).indexOf("copy")).toBe(47);
  expect(wideHit).toEqual({ x: 49, y: 0 });
  expect(capturedRows(grid, 4, 4)).toBe("tool> grep pattern=CopyMode path=src -> 12 matches");
  expect(yankRows(grid, { x: 19, y: 4 }, { x: 26, y: 4 })).toBe("CopyMode");
  expect(grid.lines[4]!.spans.reduce((width, span) => width + span.width, 0)).toBe(grid.cols);
});

test("retained widgets reflow words while a VT transcript wraps terminal cells", async () => {
  const retained = capturedRows(await syntheticGrid(80));
  const vt = new Terminal(80, 24, 100);
  disposals.push(() => vt.free());
  vt.write(
    new TextEncoder().encode(
      events
        .map((event) =>
          event.type === "message"
            ? `${event.role}> ${event.text}`
            : `tool> ${event.name} ${event.arguments} -> ${event.result}`,
        )
        .join("\r\n"),
    ),
  );

  const terminalGrid = captureScrollback(vt);
  expect(retained).toContain("reflow\nexplanations naturally");
  expect(terminalGrid).toContain("reflow explanations\n naturally");

  vt.resize(52, 24);
  expect(captureScrollback(vt)).toContain(
    "semantic so every cl\nient can reflow explanations naturally",
  );
  expect(capturedRows(await syntheticGrid(52))).toContain(
    "semantic so every\nclient can reflow explanations naturally",
  );
});
